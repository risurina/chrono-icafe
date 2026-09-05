import { Hono } from "hono";
import { withTenant, eq, and } from "agora/db";
import { schema } from "agora/db";
import { createId } from "agora";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
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
  // module's own member-purchase limiter.
  const checkoutLimiter = createRateLimiter(10, 15 * 60 * 1000, "member-payment-checkout");

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
      const cfg = await readCustomerPaymentConfig(tenantId);
      return c.json(
        paymentGatewayStatusSchema.parse({
          available: cfg !== null,
          currency: cfg?.currency ?? "PHP",
        }),
      );
    })
    .post("/checkout", zValidator("json", createCheckoutSchema), async (c) => {
      const { tenantId, memberId, email } = c.var.member;
      const input = c.req.valid("json");

      const retryAfter = await checkoutLimiter.blockedFor(`${tenantId}:${memberId}`);
      if (retryAfter !== null) {
        return c.json({ error: "Too many checkout attempts. Try again later." }, 429, {
          "Retry-After": String(retryAfter),
        });
      }

      const gateway = await resolveCustomerPaymentGateway(tenantId);
      if (!gateway) {
        throw new HttpError(400, "Online payment is not available for this tenant.");
      }
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

      const [payment] = await withTenant(tenantId, (tx) =>
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
          })
          .returning(),
      );

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
          .set({ providerReference: providerRef, updatedAt: new Date() })
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
