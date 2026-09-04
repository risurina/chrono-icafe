import { Hono } from "hono";
import { withTenant, eq, and, isNull, or, asc, desc, count } from "agora/db";
import { buildPaginationMeta } from "agora";
import { gt } from "drizzle-orm";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator, createRateLimiter } from "agora/server";
import { recordAudit } from "agora/audit";
import { chronoCreditProduct, chronoCreditGrant, chronoCreditGrantLedgerEntry } from "./schema";
import {
  creditLedgerListQuerySchema,
  portalPurchaseCreditProductSchema,
  toPortalCreditGrantDto,
  toPortalCreditLedgerEntryDto,
} from "./contracts";
import { purchaseCreditProduct } from "./service";

/**
 * Customer-facing credit-lot self-service surface — gated by the
 * foundation's `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/credits`, mirroring how `/portal/wallet` is mounted
 * (apps/chrono-api/src/app.ts). The member-purchase rate limiter (10/15min
 * per member) is applied at the app.ts mount site, not here — mirrors the
 * staff-credential throttle precedent (see AGENTS.md, "Unauthenticated
 * routes").
 */
// Member-purchase rate limiter — 10/15min per member. Declared at module
// scope (not inside the factory) so it persists across requests, matching
// every other limiter's own module-scope declaration in this codebase
// (app.ts's staffSignInLimiter, member-auth's loginLimiter, etc). Applied
// inside this module's own /purchase handler rather than at the app.ts
// mount site, since the limiter key needs `c.var.member.memberId`, which
// only exists after memberMiddleware() has already run.
const purchaseLimiter = createRateLimiter(10, 15 * 60 * 1000, "member-credit-purchase");

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
      return c.json({
        grants: grants.map(toPortalCreditGrantDto),
        totalRemainingMinutes,
      });
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
          items: rows.map(toPortalCreditLedgerEntryDto),
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )
    // Member catalog of sellable credit products — active status only.
    .get("/products", async (c) => {
      const { tenantId } = c.var.member;
      const rows = await withTenant(tenantId, (tx) =>
        tx
          .select({
            id: chronoCreditProduct.id,
            name: chronoCreditProduct.name,
            code: chronoCreditProduct.code,
            quantityMinutes: chronoCreditProduct.quantityMinutes,
            priceAmount: chronoCreditProduct.priceAmount,
            validityDays: chronoCreditProduct.validityDays,
          })
          .from(chronoCreditProduct)
          .where(and(eq(chronoCreditProduct.tenantId, tenantId), eq(chronoCreditProduct.status, "active"))),
      );
      return c.json({ items: rows });
    })
    // Wallet-funded purchase — reuses the exact staff transaction
    // (purchaseCreditProduct), just with performedByUserId omitted (a
    // member actor, not a staff one). 404 on a foreign tenant's product id
    // (withTenant's RLS scope already prevents cross-tenant reads); 409 if
    // the product isn't active; 422 (via debitWallet) on insufficient
    // wallet balance, in which case NO grant/purchase row is written — the
    // whole thing rolls back inside the one transaction.
    .post("/purchase", zValidator("json", portalPurchaseCreditProductSchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { productId } = c.req.valid("json");

      const retryAfter = await purchaseLimiter.blockedFor(`${tenantId}:${memberId}`);
      if (retryAfter !== null) {
        return c.json({ error: "Too many purchase attempts. Try again later." }, 429, {
          "Retry-After": String(retryAfter),
        });
      }
      await purchaseLimiter.record(`${tenantId}:${memberId}`);

      const result = await withTenant(tenantId, (tx) =>
        purchaseCreditProduct(tx, { tenantId, memberId, productId }),
      );

      // Best-effort, after commit — never rolls back or blocks the purchase.
      await recordAudit({
        tenantId,
        actorType: "member",
        actorId: memberId,
        action: "chronoCredit.purchased",
        targetType: "chronoCreditPurchase",
        targetId: result.purchase.id,
        metadata: { channel: "portal", productId },
      });

      return c.json({ purchase: result.purchase, grant: toPortalCreditGrantDto(result.grant) }, 201);
    });
}
