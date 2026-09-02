import { Hono } from "hono";
import { withTenant, eq, desc, count } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { listQuerySchema } from "agora";
import { chronoWallet, chronoWalletTransaction } from "./schema";

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
 * Customer-facing wallet self-service surface — gated by the foundation's
 * `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/wallet`, mirroring how `/portal/members` is mounted
 * (apps/chrono-api/src/app.ts).
 */
export function walletPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/balance", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoWallet)
          .where(eq(chronoWallet.memberId, memberId))
          .limit(1),
      );
      // No side-effecting auto-create on a read — mirrors oikos's own
      // emptyWalletBalance() pattern.
      if (!row) {
        return c.json({ balance: "0.00", currency: "PHP", exists: false });
      }
      return c.json({ balance: row.balance, currency: row.currency, exists: true });
    })
    .get(
      "/history",
      zValidator("query", listQuerySchema(["createdAt"])),
      async (c) => {
        const { tenantId, memberId } = c.var.member;
        const { page, pageSize, sort, order } = c.req.valid("query");

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoWalletTransaction)
            .where(eq(chronoWalletTransaction.memberId, memberId));
          const rows = await tx
            .select()
            .from(chronoWalletTransaction)
            .where(eq(chronoWalletTransaction.memberId, memberId))
            .orderBy(desc(chronoWalletTransaction.createdAt))
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
