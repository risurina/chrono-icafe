import { HttpError } from "agora/server";
import { withAdmin, withTenant } from "agora/db";
import { tenantIntegration } from "../../../db/schema";
import { and, eq } from "agora/db";
import { decryptSecret } from "agora/server";
import {
  parsePaymongoCustomerPayment,
  paymongoCustomerWebhookVerifier,
} from "agora/customer-payments";
import type { ParsedCustomerPayment } from "agora/customer-payments";
import type { CanonicalWebhookEvent, ResolvedWebhookScope, WebhookProviderAdapter } from "agora/webhooks/inbound";
import { getCustomerPaymentFulfilment } from "agora/customer-payments";
import { fulfilCustomerPayment } from "../../payment/fulfilment";

export const paymongoWebhookAdapter: WebhookProviderAdapter = (() => {
  // We use a WeakMap closure capture keyed by the canonical event object itself
  // to safely thread the parsed event into `dispatch()` without mutating shared state
  // across concurrent requests.
  const dispatchMap = new WeakMap<CanonicalWebhookEvent, ParsedCustomerPayment>();

  async function getCandidateSecrets(): Promise<Array<{ scope: "tenant" | "platform"; tenantId: string | null; secret: string; integrationId: string | null }>> {
    const candidates: Array<{ scope: "tenant" | "platform"; tenantId: string | null; secret: string; integrationId: string | null }> = [];

    const rows = await withAdmin((tx) =>
      tx
        .select({
          id: tenantIntegration.id,
          tenantId: tenantIntegration.tenantId,
          config: tenantIntegration.config,
        })
        .from(tenantIntegration)
        .where(
          and(
            eq(tenantIntegration.category, "customerPayment"),
            eq(tenantIntegration.provider, "paymongo"),
            eq(tenantIntegration.enabled, true)
          )
        )
    );

    for (const row of rows) {
      const cfg = (row.config ?? {}) as any;
      if (cfg.webhookSecretEnc) {
        // Assume decryptSecret is available (agora/server/crypto or packages/agora/src/core/server/crypto)
        const secret = decryptSecret(cfg.webhookSecretEnc);
        candidates.push({
          scope: "tenant",
          tenantId: row.tenantId,
          secret,
          integrationId: row.id,
        });
      }
    }

    const platformSecret = process.env.PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_WEBHOOK_SECRET;
    if (platformSecret) {
      candidates.push({
        scope: "platform",
        tenantId: null,
        secret: platformSecret,
        integrationId: null,
      });
    }

    return candidates;
  }

  return {
    async verifySignature(input) {
      const header = input.headers["paymongo-signature"] as string | undefined;
      const candidates = await getCandidateSecrets();

      for (const candidate of candidates) {
        const isValid = paymongoCustomerWebhookVerifier.verify({
          payload: input.raw,
          header,
          secret: candidate.secret,
        });
        if (isValid) {
          return;
        }
      }

      throw new HttpError(400, "Invalid signature.");
    },

    parseEvent(input) {
      const parsed = parsePaymongoCustomerPayment(input.raw);
      if (!parsed) {
        throw new HttpError(400, "Malformed PayMongo event.");
      }
      // To satisfy resolve() determinism and avoid shared state, we attach the raw input to the parsed object, 
      // or we just re-verify in resolve to find the winning candidate.
      // Wait, resolve() needs to find the winning candidate again. 
      // To re-verify, resolve() needs the raw body and the header. We can return them from parseEvent.
      return {
        parsed,
        raw: input.raw,
        header: input.headers["paymongo-signature"] as string | undefined,
      };
    },

    async resolve(parsedEvent: unknown): Promise<ResolvedWebhookScope> {
      const { raw, header } = parsedEvent as { parsed: ParsedCustomerPayment; raw: string; header: string | undefined };
      
      const candidates = await getCandidateSecrets();
      for (const candidate of candidates) {
        const isValid = paymongoCustomerWebhookVerifier.verify({
          payload: raw,
          header,
          secret: candidate.secret,
        });
        if (isValid) {
          return {
            scope: candidate.scope,
            tenantId: candidate.tenantId,
            integrationId: candidate.integrationId,
            providerAccountId: null,
          };
        }
      }

      // Should be unreachable since verifySignature passed, but just in case
      throw new HttpError(400, "Invalid signature.");
    },

    normalize(parsedEvent: unknown, resolved: ResolvedWebhookScope): CanonicalWebhookEvent {
      const { parsed } = parsedEvent as { parsed: ParsedCustomerPayment; raw: string; header: string | undefined };
      const canonical: CanonicalWebhookEvent = {
        provider: "paymongo",
        providerEventId: parsed.eventId,
        providerAccountId: resolved.providerAccountId,
        scope: resolved.scope,
        tenantId: resolved.tenantId,
        integrationId: resolved.integrationId,
        eventType: "checkout_session.payment.paid",
        resourceType: "customer_payment",
        resourceId: parsed.referenceId,
      };
      dispatchMap.set(canonical, parsed);
      return canonical;
    },

    async dispatch(canonical: CanonicalWebhookEvent) {
      const parsed = dispatchMap.get(canonical);
      if (!parsed) {
        throw new HttpError(400, "Lost parsed PayMongo event in dispatch.");
      }

      if (canonical.scope === "tenant") {
        if (!canonical.tenantId) throw new HttpError(400, "Missing tenantId for tenant dispatch.");
        await withTenant(canonical.tenantId, (tx) =>
          fulfilCustomerPayment(tx, { tenantId: canonical.tenantId!, parsed })
        );
      } else if (canonical.scope === "platform") {
        const handler = getCustomerPaymentFulfilment("chrono_payment");
        if (handler && parsed.tenantId) {
           await withTenant(parsed.tenantId, (tx) => handler(tx, { tenantId: parsed.tenantId!, parsed }));
        }
      }
    },
  };
})();
