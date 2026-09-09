import { Hono } from "hono";
import { withTenant, schema as base, eq, and, asc, desc, count, isNull, or, type TenantTx } from "agora/db";
import { gt } from "drizzle-orm";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoStationGroup } from "../station/schema";
import { chronoCreditProduct, chronoCreditGrant, chronoCreditPurchase, chronoCreditGrantLedgerEntry } from "./schema";
import {
  purchaseCreditProduct,
  grantCreditsManually,
  consumeCredits,
  adjustCreditGrant,
  voidCreditGrant,
  voidCreditPurchase,
} from "./service";
import { publishWalletLowIfCrossed } from "../wallet/service";
import {
  createCreditProductSchema,
  updateCreditProductSchema,
  purchaseCreditProductSchema,
  grantCreditsSchema,
  adjustCreditGrantSchema,
  consumeCreditsSchema,
  creditProductListQuerySchema,
  creditGrantListQuerySchema,
  creditLedgerListQuerySchema,
  creditPurchaseListQuerySchema,
} from "./contracts";

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

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

/** 404s if `memberId` does not belong to this tenant — closes the isolation
 * hole where a read/mutation could otherwise be attempted against a foreign
 * member id. Applied to every memberId-taking route, including reads. */
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

/** Resolve a station group inside the caller's own tenant, or 404 — same
 * closure discipline stations' own requireOwnBranch established. */
async function requireOwnStationGroup(tx: TenantTx, tenantId: string, stationGroupId: string) {
  const [group] = await tx
    .select({ id: chronoStationGroup.id })
    .from(chronoStationGroup)
    .where(and(eq(chronoStationGroup.id, stationGroupId), eq(chronoStationGroup.tenantId, tenantId)))
    .limit(1);
  if (!group) {
    throw new HttpError(404, "Station group not found.");
  }
}

/** A grant is "active" when it has remaining balance AND (no expiry OR not
 * yet expired) — computed live, never trusting `status` alone (see the
 * plan's "Known oikos weaknesses this plan fixes"). */
function activeGrantCondition() {
  return and(
    eq(chronoCreditGrant.status, "granted"),
    gt(chronoCreditGrant.remainingQuantity, 0),
    or(isNull(chronoCreditGrant.expiresAt), gt(chronoCreditGrant.expiresAt, new Date())),
  );
}

export function creditRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get(
      "/credits/products",
      zValidator("query", creditProductListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, status } = c.req.valid("query");
        const where = status ? eq(chronoCreditProduct.status, status) : undefined;
        const sortCol =
          sort === "name"
            ? chronoCreditProduct.name
            : sort === "code"
              ? chronoCreditProduct.code
              : chronoCreditProduct.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx.select({ value: count() }).from(chronoCreditProduct).where(where);
          const rows = await tx
            .select()
            .from(chronoCreditProduct)
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

    .post(
      "/credits/products",
      zValidator("json", createCreditProductSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["manageProducts"] });
        const { tenantId } = c.var.tenant;
        const input = c.req.valid("json");

        let created;
        try {
          created = await withTenant(tenantId, async (tx) => {
            if (input.stationGroupId) {
              await requireOwnStationGroup(tx, tenantId, input.stationGroupId);
            }
            const [row] = await tx
              .insert(chronoCreditProduct)
              .values({
                tenantId,
                name: input.name,
                code: input.code,
                quantityMinutes: input.quantityMinutes,
                priceAmount: input.priceAmount,
                stationGroupId: input.stationGroupId,
                creditPolicy: input.creditPolicy,
                validityDays: input.validityDays,
                unit: input.unit,
              })
              .returning();
            return row;
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "A credit product with that code already exists.");
          }
          throw err;
        }

        await recordStaffAudit(c, {
          action: "chronoCredit.productCreated",
          targetType: "creditProduct",
          targetId: created?.id,
          targetLabel: created?.name,
          metadata: { quantityMinutes: created?.quantityMinutes, priceAmount: created?.priceAmount },
        });
        return c.json({ product: created }, 201);
      },
    )

    .patch(
      "/credits/products/:id",
      zValidator("json", updateCreditProductSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["manageProducts"] });
        const { tenantId } = c.var.tenant;
        const id = c.req.param("id");
        const input = c.req.valid("json");

        let updated;
        try {
          [updated] = await withTenant(tenantId, async (tx) => {
            if (input.stationGroupId !== undefined && input.stationGroupId !== null) {
              await requireOwnStationGroup(tx, tenantId, input.stationGroupId);
            }
            return tx
              .update(chronoCreditProduct)
              .set({
                ...(input.name !== undefined && { name: input.name }),
                ...(input.priceAmount !== undefined && { priceAmount: input.priceAmount }),
                ...(input.stationGroupId !== undefined && { stationGroupId: input.stationGroupId }),
                ...(input.creditPolicy !== undefined && { creditPolicy: input.creditPolicy }),
                ...(input.validityDays !== undefined && { validityDays: input.validityDays }),
                ...(input.status !== undefined && { status: input.status }),
                updatedAt: new Date(),
              })
              .where(and(eq(chronoCreditProduct.id, id), eq(chronoCreditProduct.tenantId, tenantId)))
              .returning();
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "A credit product with that code already exists.");
          }
          throw err;
        }

        if (!updated) throw new HttpError(404, "Credit product not found.");

        await recordStaffAudit(c, {
          action: "chronoCredit.productUpdated",
          targetType: "creditProduct",
          targetId: updated.id,
          targetLabel: updated.name,
        });
        return c.json({ product: updated });
      },
    )

    .get("/credits/members/:memberId/summary", async (c) => {
      requirePermission(c.var.tenant.permissions, { credit: ["read"] });
      const { tenantId } = c.var.tenant;
      const memberId = c.req.param("memberId");

      const grants = await withTenant(tenantId, async (tx) => {
        await requireTenantMember(tx, memberId);
        return tx
          .select()
          .from(chronoCreditGrant)
          .where(
            and(
              eq(chronoCreditGrant.tenantId, tenantId),
              eq(chronoCreditGrant.memberId, memberId),
              activeGrantCondition(),
            ),
          )
          .orderBy(asc(chronoCreditGrant.expiresAt), asc(chronoCreditGrant.priority));
      });

      const totalRemainingMinutes = grants.reduce((sum, g) => sum + g.remainingQuantity, 0);
      return c.json({ grants, totalRemainingMinutes });
    })

    .get(
      "/credits/members/:memberId/grants",
      zValidator("query", creditGrantListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["read"] });
        const { tenantId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const { page, pageSize, sort, order, status } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;
        const sortCol = sort === "expiresAt" ? chronoCreditGrant.expiresAt : chronoCreditGrant.createdAt;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          const where = and(
            eq(chronoCreditGrant.tenantId, tenantId),
            eq(chronoCreditGrant.memberId, memberId),
            status ? eq(chronoCreditGrant.status, status) : undefined,
          );
          const [total] = await tx.select({ value: count() }).from(chronoCreditGrant).where(where);
          const rows = await tx
            .select()
            .from(chronoCreditGrant)
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({ items: rows, meta: buildPaginationMeta(page, pageSize, totalItems, sort, order) });
      },
    )

    .get(
      "/credits/members/:memberId/ledger",
      zValidator("query", creditLedgerListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["read"] });
        const { tenantId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const { page, pageSize, sort, order } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          const where = and(
            eq(chronoCreditGrantLedgerEntry.tenantId, tenantId),
            eq(chronoCreditGrantLedgerEntry.memberId, memberId),
          );
          const [total] = await tx.select({ value: count() }).from(chronoCreditGrantLedgerEntry).where(where);
          const rows = await tx
            .select()
            .from(chronoCreditGrantLedgerEntry)
            .where(where)
            .orderBy(sortFn(chronoCreditGrantLedgerEntry.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({ items: rows, meta: buildPaginationMeta(page, pageSize, totalItems, sort, order) });
      },
    )

    .post(
      "/credits/members/:memberId/purchase",
      zValidator("json", purchaseCreditProductSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["sell"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return purchaseCreditProduct(tx, {
            tenantId,
            memberId,
            productId: input.productId,
            performedByUserId: userId,
          });
        });

        await publishWalletLowIfCrossed(result.walletLow);

        await recordStaffAudit(c, {
          action: "chronoCredit.purchased",
          targetType: "creditPurchase",
          targetId: result.purchase.id,
          metadata: {
            memberId,
            productId: input.productId,
            quantityMinutes: result.grant.originalQuantity,
            priceAmount: result.purchase.priceAmount,
          },
        });
        return c.json({ purchase: result.purchase, grant: result.grant }, 201);
      },
    )

    .post(
      "/credits/members/:memberId/grant",
      zValidator("json", grantCreditsSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["grant"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          if (input.stationGroupId) {
            await requireOwnStationGroup(tx, tenantId, input.stationGroupId);
          }
          return grantCreditsManually(tx, {
            tenantId,
            memberId,
            quantityMinutes: input.quantityMinutes,
            stationGroupId: input.stationGroupId,
            creditPolicy: input.creditPolicy,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            reason: input.reason,
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoCredit.granted",
          targetType: "creditGrant",
          targetId: result.grant.id,
          metadata: { memberId, quantityMinutes: input.quantityMinutes, reason: input.reason },
        });
        return c.json(result, 201);
      },
    )

    .post(
      "/credits/members/:memberId/consume",
      zValidator("json", consumeCreditsSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["consume"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return consumeCredits(tx, {
            tenantId,
            memberId,
            quantityMinutes: input.quantityMinutes,
            stationGroupId: input.stationGroupId,
            reason: input.reason,
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoCredit.consumed",
          targetType: "creditGrant",
          targetId: memberId,
          metadata: {
            memberId,
            quantityMinutes: input.quantityMinutes,
            consumed: result.consumed,
            shortfall: result.shortfall,
          },
        });
        return c.json(result);
      },
    )

    .post(
      "/credits/grants/:id/adjust",
      zValidator("json", adjustCreditGrantSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["adjust"] });
        const { tenantId, userId } = c.var.tenant;
        const id = c.req.param("id");
        const input = c.req.valid("json");

        const updated = await withTenant(tenantId, async (tx) => {
          const [grant] = await tx
            .select()
            .from(chronoCreditGrant)
            .where(and(eq(chronoCreditGrant.id, id), eq(chronoCreditGrant.tenantId, tenantId)))
            .for("update");
          if (!grant) throw new HttpError(404, "Credit grant not found.");
          return adjustCreditGrant(tx, grant, {
            tenantId,
            deltaMinutes: input.deltaMinutes,
            reason: input.reason,
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoCredit.adjusted",
          targetType: "creditGrant",
          targetId: updated.id,
          metadata: { deltaMinutes: input.deltaMinutes, reason: input.reason },
        });
        return c.json({ grant: updated });
      },
    )

    .post("/credits/grants/:id/void", async (c) => {
      requirePermission(c.var.tenant.permissions, { credit: ["adjust"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [grant] = await tx
          .select()
          .from(chronoCreditGrant)
          .where(and(eq(chronoCreditGrant.id, id), eq(chronoCreditGrant.tenantId, tenantId)))
          .for("update");
        if (!grant) throw new HttpError(404, "Credit grant not found.");
        return voidCreditGrant(tx, grant, { tenantId, performedByUserId: userId });
      });

      await recordStaffAudit(c, {
        action: "chronoCredit.grantVoided",
        targetType: "creditGrant",
        targetId: updated.id,
      });
      return c.json({ grant: updated });
    })

    .get(
      "/credits/purchases",
      zValidator("query", creditPurchaseListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, memberId } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;
        const where = and(
          eq(chronoCreditPurchase.tenantId, tenantId),
          memberId ? eq(chronoCreditPurchase.memberId, memberId) : undefined,
        );

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx.select({ value: count() }).from(chronoCreditPurchase).where(where);
          const rows = await tx
            .select()
            .from(chronoCreditPurchase)
            .where(where)
            .orderBy(sortFn(chronoCreditPurchase.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({ items: rows, meta: buildPaginationMeta(page, pageSize, totalItems, sort, order) });
      },
    )
    .post(
      "/credits/purchases/:id/void",
      async (c) => {
        requirePermission(c.var.tenant.permissions, { credit: ["adjust"] });
        const { tenantId, userId } = c.var.tenant;
        const id = c.req.param("id");

        const result = await withTenant(tenantId, async (tx) => {
          const [purchase] = await tx
            .select()
            .from(chronoCreditPurchase)
            .where(and(eq(chronoCreditPurchase.id, id), eq(chronoCreditPurchase.tenantId, tenantId)))
            .for("update");
          if (!purchase) throw new HttpError(404, "Credit purchase not found.");
          if (!purchase.grantId) throw new HttpError(404, "Credit purchase not found.");
          const [grant] = await tx
            .select()
            .from(chronoCreditGrant)
            .where(and(eq(chronoCreditGrant.id, purchase.grantId), eq(chronoCreditGrant.tenantId, tenantId)))
            .for("update");
          if (!grant) throw new HttpError(404, "Credit grant not found.");
          return voidCreditPurchase(tx, purchase, grant, { tenantId, performedByUserId: userId });
        });

        await publishWalletLowIfCrossed(result.walletLow);

        await recordStaffAudit(c, {
          action: "chronoCredit.purchaseVoided",
          targetType: "creditPurchase",
          targetId: id,
        });
        return c.json({ purchase: result.purchase, walletTransaction: result.walletTransaction });
      },
    );
}
