import { Hono } from "hono";
import { withTenant, eq, and } from "agora/db";
import { schema } from "agora/db";
import { createId } from "agora";
import {
  type MemberVars,
  memberMiddleware,
  requireMemberActionHeader,
} from "agora/member-auth";
import {
  zValidator,
  createRateLimiter,
  HttpError,
  resolveOrgFromRequest,
  resolveCustomerPaymentGateway,
  type CustomerPaymentIntegrationConfig,
} from "agora/server";
import { chronoPayment } from "./schema";
import { chronoCreditProduct } from "../credit/schema";
import { requireAppliedMembership } from "../member/access";
import { toCents } from "../wallet/money";
import {
  createCheckoutSchema,
  paymentGatewayStatusSchema,
  type PortalPaymentDto,
} from "./contracts";

const { tenantIntegration } = schema;

/**
 * Member-initiated online checkout — gated by the foundation's
 * `memberMiddleware()`, NOT `tenantMiddleware()`/`requirePermission`.
 * Mounted directly on the Hono app at `/portal/payments`. `memberId` and
 * `tenantId` come from `c.var.member` everywhere here, never client input.
 *
 * `tenantHostUrl` is injected from `app.ts` (mirrors `agora/billing`'s own
 * `billingRoutes({ tenantHostUrl })` seam) so this module never hardcodes
 * `APP_DOMAIN`/scheme itself.
 */
export function paymentPortalRoutes(opts: {
  tenantHostUrl: (slug: string, path: string) => string;
}) {
  const { tenantHostUrl } = opts;

  // 10 checkouts / 15 min per member — a checkout writes a DB row and makes
  // an outbound PSP call, same throttle-shape reasoning as the credit
  // module's own member-purchase limiter. `failOpen: false`
  // (member-wallet-operation-hardening plan) — block (429) on a Redis
  // outage rather than silently drop throttling on this money-moving route.
  const checkoutLimiter = createRateLimiter(10, 15 * 60 * 1000, "member-payment-checkout", {
    failOpen: false,
  });

  /** True if `err` is a Postgres unique-violation (SQLSTATE 23505) — same
   * per-file convention as `credit/routes.ts`. */
  function isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
  }

  async function readCustomerPaymentConfig(tenantId: string) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(tenantIntegration)
        .where(
          and(
            eq(tenantIntegration.tenantId, tenantId),
            eq(tenantIntegration.category, "customerPayment"),
            eq(tenantIntegration.enabled, true),
          ),
        )
        .limit(1),
    );
    if (!row) return null;
    return (row.config ?? {}) as CustomerPaymentIntegrationConfig;
  }

  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/gateway", async (c) => {
      const { tenantId } = c.var.member;
      // Availability must match what POST /checkout will actually do:
      // `resolveCustomerPaymentGateway` returns a usable gateway when EITHER
      // the tenant has its own configured row OR the platform fallback is
      // configured (`.ai/plans/agora/in-progress/
      // platform-paymongo-customer-payment-fallback/README.md`). Reading only
      // the tenant's own row here (as this route used to) kept the "Top up
      // online" button disabled for a fallback-only tenant even though
      // checkout would succeed — see that plan's Phase 2 addendum.
      const [resolved, cfg] = await Promise.all([
        resolveCustomerPaymentGateway(tenantId),
        readCustomerPaymentConfig(tenantId),
      ]);
      return c.json(
        paymentGatewayStatusSchema.parse({
          available: resolved !== null,
          currency: cfg?.currency ?? "PHP",
          scope: resolved?.scope,
        }),
      );
    })
    .post("/checkout", zValidator("json", createCheckoutSchema), async (c) => {
      requireMemberActionHeader(c);
      await requireAppliedMembership(c);
      const { tenantId, memberId, email } = c.var.member;
      const input = c.req.valid("json");
      const idempotencyKey = c.req.header("Idempotency-Key")?.slice(0, 128);

      const findByIdempotencyKey = (key: string) =>
        withTenant(tenantId, (tx) =>
          tx
            .select()
            .from(chronoPayment)
            .where(
              and(
                eq(chronoPayment.tenantId, tenantId),
                eq(chronoPayment.memberId, memberId),
                eq(chronoPayment.idempotencyKey, key),
              ),
            )
            .then((rows) => rows[0]),
        );

      // Returns the ORIGINAL checkout unchanged on replay — no second
      // pending row, no second PSP session. A found row with no
      // `checkoutUrl` yet means a prior attempt with this same key is still
      // mid-flight (or died before reaching the PSP) — reported as a 409
      // rather than silently duplicating the attempt or returning nothing.
      if (idempotencyKey) {
        const existing = await findByIdempotencyKey(idempotencyKey);
        if (existing) {
          if (existing.checkoutUrl) {
            return c.json({ paymentId: existing.id, checkoutUrl: existing.checkoutUrl }, 200);
          }
          throw new HttpError(
            409,
            "A checkout for this request is still being created. Retry with a new Idempotency-Key.",
          );
        }
      }

      const retryAfter = await checkoutLimiter.blockedFor(`${tenantId}:${memberId}`);
      if (retryAfter !== null) {
        return c.json({ error: "Too many checkout attempts. Try again later." }, 429, {
          "Retry-After": String(retryAfter),
        });
      }

      const resolved = await resolveCustomerPaymentGateway(tenantId);
      if (!resolved) {
        throw new HttpError(400, "Online payment is not available for this tenant.");
      }
      const { gateway, scope } = resolved;
      const cfg = await readCustomerPaymentConfig(tenantId);
      const currency = cfg?.currency ?? "PHP";

      let amount: string;
      let description: string;
      let creditProductId: string | null = null;

      if (input.purpose === "credit_purchase") {
        const [product] = await withTenant(tenantId, (tx) =>
          tx
            .select()
            .from(chronoCreditProduct)
            .where(
              and(
                eq(chronoCreditProduct.id, input.productId!),
                eq(chronoCreditProduct.tenantId, tenantId),
              ),
            ),
        );
        if (!product) throw new HttpError(404, "Credit product not found.");
        if (product.status !== "active") {
          throw new HttpError(409, "This product is not available for sale.");
        }
        amount = product.priceAmount;
        description = `${product.name} (${product.quantityMinutes} minutes)`;
        creditProductId = product.id;
      } else {
        amount = input.amount!;
        description = "Wallet top-up";
      }

      await checkoutLimiter.record(`${tenantId}:${memberId}`);

      let payment: typeof chronoPayment.$inferSelect | undefined;
      try {
        [payment] = await withTenant(tenantId, (tx) =>
          tx
            .insert(chronoPayment)
            .values({
              id: createId(),
              tenantId,
              memberId,
              amount,
              currency,
              method: "online",
              status: "pending",
              purpose: input.purpose,
              creditProductId,
              idempotencyKey,
              gatewayScope: scope,
            })
            .returning(),
        );
      } catch (err) {
        // Two concurrent requests carrying the same key both missed the
        // lookup above and both reached the insert — the loser's unique
        // violation means the winner already holds (or is still creating)
        // the row we'd have returned anyway.
        if (idempotencyKey && isUniqueViolation(err)) {
          const existing = await findByIdempotencyKey(idempotencyKey);
          if (existing?.checkoutUrl) {
            return c.json({ paymentId: existing.id, checkoutUrl: existing.checkoutUrl }, 200);
          }
          throw new HttpError(
            409,
            "A checkout for this request is still being created. Retry with a new Idempotency-Key.",
          );
        }
        throw err;
      }

      // The tenant slug for the redirect URLs comes from the request's own
      // resolved host (`x-tenant-slug`/`x-tenant-host`, the same headers
      // `memberMiddleware()` itself used to establish this tenant context)
      // — never from client-suppliable body input.
      const org = await resolveOrgFromRequest(c);
      if (!org || org.id !== tenantId) {
        throw new HttpError(400, "Unable to resolve the tenant host for this request.");
      }

      const { url, providerRef } = await gateway.createCheckout({
        tenantId,
        referenceId: payment!.id,
        referenceType: "chrono_payment",
        amountMinorUnits: Number(toCents(amount)),
        currency,
        description,
        // The member-area web app moved everything under `/member/*` after
        // this plan's Pass 2 was written (`/portal/credits` no longer
        // exists) — the wallet page is the single return/poll destination
        // for both purposes, since fulfilment always credits the wallet
        // first (see fulfilment.ts). `payment=cancelled` is a literal
        // sentinel the web app special-cases without an API call.
        successUrl: tenantHostUrl(org.slug, `/member/wallet?payment=${payment!.id}`),
        cancelUrl: tenantHostUrl(org.slug, "/member/wallet?payment=cancelled"),
        customerEmail: email,
      });

      await withTenant(tenantId, (tx) =>
        tx
          .update(chronoPayment)
          // `checkoutUrl` stored so a replayed request with this same
          // Idempotency-Key returns the exact same redirect URL instead of
          // starting a second PSP session.
          .set({ providerReference: providerRef, checkoutUrl: url, updatedAt: new Date() })
          .where(eq(chronoPayment.id, payment!.id)),
      );

      return c.json({ paymentId: payment!.id, checkoutUrl: url }, 201);
    })
    // The caller's OWN payment only — memberId is part of the WHERE, not
    // just tenant scope, and a payment belonging to another member 404s
    // rather than 403ing (no existence leak).
    .get("/:id", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const id = c.req.param("id");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoPayment)
          .where(
            and(
              eq(chronoPayment.id, id),
              eq(chronoPayment.tenantId, tenantId),
              eq(chronoPayment.memberId, memberId),
            ),
          ),
      );
      if (!row) throw new HttpError(404, "Payment not found.");

      const dto: PortalPaymentDto = {
        id: row.id,
        status: row.status as PortalPaymentDto["status"],
        purpose: row.purpose as PortalPaymentDto["purpose"],
        amount: row.amount,
        currency: row.currency,
        fulfilledAt: row.fulfilledAt ? row.fulfilledAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      };
      return c.json(dto);
    });
}
