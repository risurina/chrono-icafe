import { Hono } from "hono";
import { withTenant, eq, and, isNull, or, asc, desc, count } from "agora/db";
import { gt } from "drizzle-orm";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { chronoCreditGrant, chronoCreditGrantLedgerEntry } from "./schema";
import { creditLedgerListQuerySchema } from "./contracts";

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

/**
 * Customer-facing credit-lot self-service surface — gated by the
 * foundation's `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/credits`, mirroring how `/portal/wallet` is mounted
 * (apps/chrono-api/src/app.ts).
 */
export function creditPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/balance", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const grants = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoCreditGrant)
          .where(
            and(
              eq(chronoCreditGrant.tenantId, tenantId),
              eq(chronoCreditGrant.memberId, memberId),
              eq(chronoCreditGrant.status, "granted"),
              gt(chronoCreditGrant.remainingQuantity, 0),
              or(isNull(chronoCreditGrant.expiresAt), gt(chronoCreditGrant.expiresAt, new Date())),
            ),
          )
          .orderBy(asc(chronoCreditGrant.expiresAt), asc(chronoCreditGrant.priority)),
      );
      // Empty list, not an error, if none exist — mirrors wallet's own
      // no-side-effecting-auto-create-on-a-read pattern.
      const totalRemainingMinutes = grants.reduce((sum, g) => sum + g.remainingQuantity, 0);
      return c.json({ grants, totalRemainingMinutes });
    })
    .get(
      "/ledger",
      zValidator("query", creditLedgerListQuerySchema),
      async (c) => {
        const { tenantId, memberId } = c.var.member;
        const { page, pageSize, sort, order } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;
        const where = and(
          eq(chronoCreditGrantLedgerEntry.tenantId, tenantId),
          eq(chronoCreditGrantLedgerEntry.memberId, memberId),
        );

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
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

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    );
}
