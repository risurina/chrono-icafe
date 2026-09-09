import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HttpError } from "agora/server";
import { withAdmin } from "agora/db";
import { getWebhookProvider } from "./registry";
import { chronoWebhookEvent } from "./schema";

/**
 * Generic inbound webhook ingress
 * (`.ai/plans/chrono/in-progress/centralized-webhook-architecture.md`, Phase 1).
 * Mounted at `/api/v1/webhooks/:provider`, outside `/rpc` and outside the
 * tenant-authenticated `apiV1` chain — an inbound provider webhook has neither
 * a resolved tenant nor an API key.
 *
 * Lifecycle, always in this order: verifySignature -> parseEvent -> resolve ->
 * normalize -> persist -> ack. `verifySignature`/`parseEvent` throwing is the
 * adapter's own responsibility (as `HttpError`, from `agora/server`), not the
 * ingress's — keeps the ingress generic across adapters with different
 * failure shapes.
 */
export function webhookIngressRoutes() {
  return new Hono().post("/:provider", async (c) => {
    const providerId = c.req.param("provider");
    const adapter = getWebhookProvider(providerId);
    if (!adapter) throw new HttpError(404, "Unknown webhook provider.");

    const raw = await c.req.text();
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    const event = { raw, headers };

    // Throws HttpError(400) on an invalid signature — the adapter's job.
    await adapter.verifySignature(event);

    // Throws HttpError(400) on a malformed body — the adapter's job.
    const parsed = adapter.parseEvent(event);
    const resolved = await adapter.resolve(parsed);
    const canonical = adapter.normalize(parsed, resolved);

    const payloadHash = createHash("sha256").update(raw).digest("hex");

    const inserted = await withAdmin((tx) =>
      tx
        .insert(chronoWebhookEvent)
        .values({
          provider: canonical.provider,
          providerEventId: canonical.providerEventId,
          providerAccountId: canonical.providerAccountId,
          scope: canonical.scope,
          tenantId: canonical.tenantId,
          integrationId: canonical.integrationId,
          eventType: canonical.eventType,
          resourceType: canonical.resourceType,
          resourceId: canonical.resourceId,
          signatureVerified: true,
          processingStatus: canonical.scope === "unresolved" ? "needs_resolution" : "received",
          payloadHash,
        })
        .onConflictDoNothing({
          target: [chronoWebhookEvent.provider, chronoWebhookEvent.providerEventId],
        })
        .returning({ id: chronoWebhookEvent.id }),
    );

    if (inserted.length === 0) {
      return c.json({ received: true, deduped: true });
    }

    // Phase 1 stops here: persisted + acknowledged. Async processing/dispatch
    // to a domain service is Phase 2+, once a real provider exists to
    // dispatch for.
    return c.json({ received: true });
  });
}
