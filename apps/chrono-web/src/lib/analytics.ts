/**
 * Chrono's growth-loop event vocabulary.
 *
 * App-local on purpose. `packages/agora`'s integrations registry already
 * reserves an inert "analytics" platform-integration category, but building a
 * real provider (interface + registry + selector + platform wiring, mirroring
 * email/storage/billing) is a bigger foundation change than a marketing
 * repositioning should introduce unasked. It moves to the foundation when a
 * second app needs event tracking too.
 *
 * ── Event props carry NO personal or lead data ────────────────────────────
 * These events are headed for an as-yet-unchosen collector, so nothing
 * identifying goes into them: no email, no customer id, no business name, no
 * city, no free-text message. `PLAYER_DISCOVERY_SEARCH` deliberately does NOT
 * carry the raw query string — it is a user-typed business name, and the demand
 * it represents is already captured deliberately, and with consent, by the lead
 * table. Sending it here as well would be a second copy nobody asked for.
 *
 * An `organizationId` is tenant metadata, not personal data, so it is fine.
 */
export type AnalyticsEvents = {
  /** A player created a global customer account. */
  PLAYER_SIGNUP: Record<string, never>;
  /** A settled search on /discover — one event per search, never per keystroke. */
  PLAYER_DISCOVERY_SEARCH: { resultCount: number; hadResults: boolean };
  /** A player opened a listed business's public page from a result card. */
  BUSINESS_VIEW: { organizationId: string };
  /** A player asked for a business that isn't on Chrono yet. */
  BUSINESS_INVITE_REQUEST: { hadCity: boolean; hadMessage: boolean };
  /** A business created its workspace. */
  PARTNER_SIGNUP: Record<string, never>;
  /** A partner acknowledged the demand banner — an explicit action, not an impression. */
  PARTNER_CLAIM: { demandCount: number };
  /**
   * A player joined a business through the existing apply-to-tenant flow.
   *
   * Carries `tenantSlug`, not `organizationId`: the apply prompt runs on the
   * tenant host and has the slug from the URL, never the org id. The slug is
   * public and non-personal, same as an org id.
   */
  PLAYER_CONNECTS_TO_BUSINESS: { tenantSlug: string };
};

export type AnalyticsEvent = keyof AnalyticsEvents;

/**
 * Record one product event.
 *
 * There is no collector wired yet, so this logs in development and is a no-op
 * everywhere else. That is deliberate: a silent no-op in production is honest
 * (nothing is being collected), whereas logging would put event data into
 * production browser consoles for no benefit.
 *
 * Wiring a real destination later is a change to THIS function only — never to
 * the call sites, which is the whole reason the indirection exists.
 */
export function track<E extends AnalyticsEvent>(
  event: E,
  ...args: Record<string, never> extends AnalyticsEvents[E]
    ? [props?: AnalyticsEvents[E]]
    : [props: AnalyticsEvents[E]]
): void {
  const [props] = args;
  if (process.env.NODE_ENV !== "development") return;
  // The one sanctioned console call in this app (.ai/rules/code-quality.md):
  // a dev-only stand-in for a collector that does not exist yet.
  // eslint-disable-next-line no-console
  console.log("[analytics]", event, props ?? {});
}
