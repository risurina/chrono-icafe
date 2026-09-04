import { Hono } from "hono";
import { withTenant, eq, asc, desc, count } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { listQuerySchema, buildPaginationMeta } from "agora";
import * as base from "agora/db/schema";
import { chronoLoyaltyAccount, chronoLoyaltyTransaction } from "./schema";
import { computeLevel } from "./level";
import { toPortalLoyaltyTransactionDto } from "./contracts";

/**
 * Customer-facing loyalty read surface — gated by the foundation's
 * `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/loyalty`, mirroring how `/portal/wallet` is mounted.
 *
 * `GET /me` never creates an account row on read (mirrors
 * `walletPortalRoutes`'s own "no side-effecting auto-create on a read"
 * precedent) — a member with no earn history yet simply sees
 * `account: null` and the bronze/0% level a zero-lifetime-points member
 * would have.
 */
export function loyaltyPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/me", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const [account, member] = await withTenant(tenantId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(chronoLoyaltyAccount)
            .where(eq(chronoLoyaltyAccount.memberId, memberId))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          tx
            .select({ createdAt: base.tenantMember.createdAt })
            .from(base.tenantMember)
            .where(eq(base.tenantMember.id, memberId))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        ]),
      );

      const lifetimePoints = account?.lifetimePoints ?? 0;
      const level = computeLevel(lifetimePoints);

      return c.json({
        account: account
          ? {
              pointsBalance: account.pointsBalance,
              lifetimePoints: account.lifetimePoints,
              tier: account.tier,
            }
          : null,
        level,
        memberSince: member?.createdAt.toISOString() ?? new Date(0).toISOString(),
      });
    })
    .get("/history", zValidator("query", listQuerySchema(["createdAt"])), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { page, pageSize, sort, order } = c.req.valid("query");
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
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
        items: rows.map(toPortalLoyaltyTransactionDto),
        meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
      });
    });
}
