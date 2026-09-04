import { Hono } from "hono";
import { withTenant, eq, asc, desc, count } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { listQuerySchema, buildPaginationMeta } from "agora";
import { chronoWallet, chronoWalletTransaction } from "./schema";

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
        // Must actually apply the requested order — `buildPaginationMeta` echoes it
        // back to the client, so a hardcoded sort here would report an order the
        // rows do not follow.
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoWalletTransaction)
            .where(eq(chronoWalletTransaction.memberId, memberId));
          const rows = await tx
            .select()
            .from(chronoWalletTransaction)
            .where(eq(chronoWalletTransaction.memberId, memberId))
            .orderBy(sortFn(chronoWalletTransaction.createdAt))
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
