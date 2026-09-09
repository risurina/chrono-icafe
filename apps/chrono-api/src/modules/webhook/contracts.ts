/**
 * Canonical webhook event shape + the provider adapter interface
 * (`.ai/plans/chrono/in-progress/centralized-webhook-architecture.md`, Phase 1).
 *
 * These are internal server-side contracts between the ingress and adapters —
 * they never cross the wire to a client, so `.ai/rules/dto.md`'s "define wire
 * shapes with Zod" doesn't apply here. It applies once a `/rpc` route exposes
 * these events to the dashboard, which is out of scope for this phase.
 */

export interface ProviderWebhookEvent {
  raw: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface CanonicalWebhookEvent {
  provider: string;
  providerEventId: string;
  providerAccountId: string | null;
  scope: "platform" | "tenant" | "unresolved";
  tenantId: string | null;
  integrationId: string | null;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
}

export interface ResolvedWebhookScope {
  scope: "platform" | "tenant" | "unresolved";
  tenantId: string | null;
  integrationId: string | null;
  providerAccountId: string | null;
}

/**
 * Adapter contract that every webhook provider (e.g. PayMongo, Maya, Paddle)
 * must implement. The ingress lifecycle always runs in this exact order:
 * verifySignature -> parseEvent -> resolve -> normalize -> persist -> ack.
 */
export interface WebhookProviderAdapter {
  /** Throws on an invalid signature. Never trust the payload before this passes. */
  verifySignature(input: ProviderWebhookEvent): Promise<void>;

  /** Parse the raw body into a provider-shaped event. Throws on malformed JSON. */
  parseEvent(input: ProviderWebhookEvent): unknown;

  /**
   * Resolve scope/tenant/integration from the parsed event. Returns
   * `scope: "unresolved"` (never guesses) when it cannot determine ownership.
   */
  resolve(parsed: unknown): Promise<ResolvedWebhookScope>;

  /** Normalize into the canonical shape once scope/tenant are known. */
  normalize(parsed: unknown, resolved: ResolvedWebhookScope): CanonicalWebhookEvent;
}
