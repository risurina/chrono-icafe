import { Hono } from "hono";
import { withTenant, eq, and, isNull, or, asc, desc, count } from "agora/db";
import { buildPaginationMeta } from "agora";
import { gt } from "drizzle-orm";
import {
  type MemberVars,
  memberMiddleware,
  requireMemberActionHeader,
} from "agora/member-auth";
import { zValidator, createRateLimiter } from "agora/server";
import { recordAudit } from "agora/audit";
import {
  chronoCreditProduct,
  chronoCreditGrant,
  chronoCreditGrantLedgerEntry,
  chronoCreditPurchase,
} from "./schema";
import {
  creditLedgerListQuerySchema,
  portalPurchaseCreditProductSchema,
  toPortalCreditGrantDto,
  toPortalCreditLedgerEntryDto,
} from "./contracts";
import { purchaseCreditProduct } from "./service";
import { publishWalletLowIfCrossed } from "../wallet/service";
import { requireAppliedMembership } from "../member/access";

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
// only exists after memberMiddleware() has already run. `failOpen: false`
// (member-wallet-operation-hardening plan) — a money-moving route should
// block (429) on a Redis outage, not silently drop throttling.
const purchaseLimiter = createRateLimiter(10, 15 * 60 * 1000, "member-credit-purchase", {
  failOpen: false,
});

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505) — same
 * per-file convention as `credit/routes.ts`. Used to catch the race where two
 * concurrent requests carrying the same Idempotency-Key both miss the
 * lookup-before-execute check below and both reach the insert. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

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
    //
    // `requireMemberActionHeader` (CSRF-preflight) and an optional
    // `Idempotency-Key` header both added by the
    // member-wallet-operation-hardening plan — a double-click or a client
    // retry of a timed-out-but-succeeded request replays the same key and
    // gets the ORIGINAL purchase back (200) instead of a second debit. A
    // request with no key is unprotected, same as before this plan.
    .post("/purchase", zValidator("json", portalPurchaseCreditProductSchema), async (c) => {
      requireMemberActionHeader(c);
      await requireAppliedMembership(c);
      const { tenantId, memberId } = c.var.member;
      const { productId } = c.req.valid("json");
      const idempotencyKey = c.req.header("Idempotency-Key")?.slice(0, 128);

      const findByIdempotencyKey = (key: string) =>
        withTenant(tenantId, (tx) =>
          tx
            .select({ purchase: chronoCreditPurchase, grant: chronoCreditGrant })
            .from(chronoCreditPurchase)
            .innerJoin(chronoCreditGrant, eq(chronoCreditPurchase.grantId, chronoCreditGrant.id))
            .where(
              and(
                eq(chronoCreditPurchase.tenantId, tenantId),
                eq(chronoCreditPurchase.memberId, memberId),
                eq(chronoCreditPurchase.idempotencyKey, key),
              ),
            )
            .then((rows) => rows[0]),
        );

      if (idempotencyKey) {
        const existing = await findByIdempotencyKey(idempotencyKey);
        if (existing) {
          return c.json(
            { purchase: existing.purchase, grant: toPortalCreditGrantDto(existing.grant) },
            200,
          );
        }
      }

      const retryAfter = await purchaseLimiter.blockedFor(`${tenantId}:${memberId}`);
      if (retryAfter !== null) {
        return c.json({ error: "Too many purchase attempts. Try again later." }, 429, {
          "Retry-After": String(retryAfter),
        });
      }
      await purchaseLimiter.record(`${tenantId}:${memberId}`);

      let result;
      try {
        result = await withTenant(tenantId, (tx) =>
          purchaseCreditProduct(tx, { tenantId, memberId, productId, idempotencyKey }),
        );
      } catch (err) {
        // Two concurrent requests carrying the same key both missed the
        // lookup above and both reached the insert — the loser's unique
        // violation is not a real error, it means the winner already holds
        // the row we'd have returned anyway.
        if (idempotencyKey && isUniqueViolation(err)) {
          const existing = await findByIdempotencyKey(idempotencyKey);
          if (existing) {
            return c.json(
              { purchase: existing.purchase, grant: toPortalCreditGrantDto(existing.grant) },
              200,
            );
          }
        }
        throw err;
      }

      // After the transaction has committed — never inside it — mirroring
      // `session/service.ts`'s `publishSessionTransition` discipline.
      await publishWalletLowIfCrossed(result.walletLow);

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
