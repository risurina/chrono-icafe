import { Hono } from "hono";
import { withTenant, schema as base, eq, and, or, ilike, desc, asc, count, type TenantTx } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoLoyaltyAccount, chronoLoyaltyTransaction } from "./schema";
import { applyPointsDelta } from "./service";
import {
  earnPointsSchema,
  redeemPointsSchema,
  adjustPointsSchema,
  loyaltyAccountListQuerySchema,
} from "./contracts";
import { listQuerySchema } from "agora";

function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    startItem: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
    endItem: Math.min(page * pageSize, totalItems),
    sort,
    order,
  };
}

/** 404s if `memberId` does not belong to this tenant — closes the isolation hole
 * where a mutation could otherwise be attempted against a foreign member id. */
async function requireTenantMember(tx: TenantTx, memberId: string) {
  const [row] = await tx
    .select({ id: base.tenantMember.id })
    .from(base.tenantMember)
    .where(eq(base.tenantMember.id, memberId))
    .limit(1);
  if (!row) {
    throw new HttpError(404, "Member not found.");
  }
}

export function loyaltyRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get(
      "/loyalty/accounts",
      zValidator("query", loyaltyAccountListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { loyalty: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, tier, search } = c.req.valid("query");
        const sortCol =
          sort === "pointsBalance" ? chronoLoyaltyAccount.pointsBalance : chronoLoyaltyAccount.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const where = and(
          tier ? eq(chronoLoyaltyAccount.tier, tier) : undefined,
          search
            ? or(
                ilike(base.tenantMember.name, `%${search}%`),
                ilike(base.tenantMember.email, `%${search}%`),
              )
            : undefined,
        );

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoLoyaltyAccount)
            .innerJoin(base.tenantMember, eq(chronoLoyaltyAccount.memberId, base.tenantMember.id))
            .where(where);
          const rows = await tx
            .select({
              id: chronoLoyaltyAccount.id,
              memberId: chronoLoyaltyAccount.memberId,
              memberName: base.tenantMember.name,
              memberEmail: base.tenantMember.email,
              pointsBalance: chronoLoyaltyAccount.pointsBalance,
              lifetimePoints: chronoLoyaltyAccount.lifetimePoints,
              tier: chronoLoyaltyAccount.tier,
              createdAt: chronoLoyaltyAccount.createdAt,
              updatedAt: chronoLoyaltyAccount.updatedAt,
            })
            .from(chronoLoyaltyAccount)
            .innerJoin(base.tenantMember, eq(chronoLoyaltyAccount.memberId, base.tenantMember.id))
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .get("/loyalty/accounts/:memberId", async (c) => {
      requirePermission(c.var.tenant.permissions, { loyalty: ["read"] });
      const { tenantId } = c.var.tenant;
      const memberId = c.req.param("memberId");

      const account = await withTenant(tenantId, async (tx) => {
        await requireTenantMember(tx, memberId);
        const [row] = await tx
          .select()
          .from(chronoLoyaltyAccount)
          .where(eq(chronoLoyaltyAccount.memberId, memberId))
          .limit(1);
        return row ?? null;
      });

      // Reads never create a row (mirrors oikos's own correct "reads never
      // create" behavior) — synthesize a zero-state shape for a member who
      // has never earned anything instead.
      return c.json({
        account: account ?? {
          memberId,
          pointsBalance: 0,
          lifetimePoints: 0,
          tier: "bronze",
          exists: false,
        },
      });
    })

    .get(
      "/loyalty/accounts/:memberId/transactions",
      zValidator("query", listQuerySchema(["createdAt"])),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { loyalty: ["read"] });
        const { tenantId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const { page, pageSize, sort, order } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          const [total] = await tx
            .select({ value: count() })
            .from(chronoLoyaltyTransaction)
            .where(eq(chronoLoyaltyTransaction.memberId, memberId));
          const rows = await tx
            .select()
            .from(chronoLoyaltyTransaction)
            .where(eq(chronoLoyaltyTransaction.memberId, memberId))
            .orderBy(sortFn(chronoLoyaltyTransaction.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .post(
      "/loyalty/accounts/:memberId/earn",
      zValidator("json", earnPointsSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { loyalty: ["manage"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return applyPointsDelta(tx, {
            tenantId,
            memberId,
            type: "earn",
            points: input.points,
            reason: input.reason,
            referenceType: "manual",
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoLoyalty.earned",
          targetType: "loyaltyAccount",
          targetId: result.account.id,
        });
        return c.json(result);
      },
    )

    .post(
      "/loyalty/accounts/:memberId/redeem",
      zValidator("json", redeemPointsSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { loyalty: ["manage"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return applyPointsDelta(tx, {
            tenantId,
            memberId,
            type: "redeem",
            points: -input.points,
            reason: input.reason,
            referenceType: "manual",
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoLoyalty.redeemed",
          targetType: "loyaltyAccount",
          targetId: result.account.id,
        });
        return c.json(result);
      },
    )

    .post(
      "/loyalty/accounts/:memberId/adjust",
      zValidator("json", adjustPointsSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { loyalty: ["adjust"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return applyPointsDelta(tx, {
            tenantId,
            memberId,
            type: "adjustment",
            points: input.delta,
            reason: input.reason,
            referenceType: "manual",
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoLoyalty.adjusted",
          targetType: "loyaltyAccount",
          targetId: result.account.id,
        });
        return c.json(result);
      },
    );
}
