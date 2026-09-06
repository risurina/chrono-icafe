/**
 * Product analytics — a thin, app-local abstraction over "an event happened".
 *
 * App-local on purpose. `packages/agora`'s integrations registry already
 * reserves an inert "analytics" platform-integration category, but building a
 * real provider (interface + registry + selector + platform wiring, mirroring
 * email/storage/billing) is a bigger foundation change than either of the
 * plans below should introduce unasked. It moves to the foundation when a
 * second app needs event tracking too.
 *
 * There is no analytics vendor in this repo. The point of this module is that
 * adding one is a change to `track()` alone: every call site already names a
 * closed event and a typed prop shape, so nothing else has to be revisited.
 *
 * Until then it logs in development and no-ops elsewhere. That is deliberately
 * the ONLY place in this app allowed to `console.log` (`.ai/rules/code-quality.md`).
 *
 * ── Event props carry NO personal or lead data ────────────────────────────
 * These events are headed for an as-yet-unchosen collector, so nothing
 * identifying goes into them: no email, no customer id, no business name, no
 * city, no free-text message. `PLAYER_DISCOVERY_SEARCH` deliberately does NOT
 * carry the raw query string — it is a user-typed business name, and the
 * demand it represents is already captured deliberately, and with consent, by
 * the lead table. Sending it here as well would be a second copy nobody
 * asked for. An `organizationId` or `tenantSlug` is tenant metadata, not
 * personal data, so it is fine.
 *
 * This file was built independently by two sibling plans
 * (`tenant-white-label-site` and `two-sided-growth-loop`, both under
 * `.ai/plans/chrono/`) with disjoint event vocabularies and has since been
 * reconciled into one closed union — see each event's own doc comment below
 * for provenance. `AnalyticsEvent` is derived from the map's keys precisely so
 * a future extension only ever touches the map.
 */

/**
 * The per-event props map — the single source of truth for this app's event
 * vocabulary.
 */
export type AnalyticsEventProps = {
  /** A tenant's public landing page was viewed. */
  TENANT_PAGE_VIEW: { tenantName: string; path: string };
  /** A tenant's `/stations` availability page was viewed. */
  TENANT_STATIONS_VIEW: { tenantName: string; totalStations: number };
  /** A player account was created from a tenant surface. */
  PLAYER_SIGNUP_FROM_TENANT: { method: "portal_sign_up" | "customer_apply" };
  /** A player signed in from a tenant surface. */
  PLAYER_LOGIN_FROM_TENANT: Record<string, never>;
  /** The tenant's page was shared. */
  TENANT_SHARE: { tenantName: string; method: "native" | "clipboard" };
  /** A directions affordance was used. */
  DIRECTIONS_CLICK: { source: "contact_map" | "stations_section" };
  /** A phone, email or social link on the contact section was used. */
  CONTACT_CLICK: { channel: string };
  /** The live-availability section's own call to action was used. */
  STATION_AVAILABILITY_INTERACTION: { action: string };
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

/**
 * The closed event-name union, DERIVED from the props map above rather than
 * declared separately — so extending the map is the only edit a future change
 * needs.
 */
export type AnalyticsEvent = keyof AnalyticsEventProps;

/**
 * Record one product event. Safe to call from any client component; a no-op
 * on the server, so a stray call from a server render cannot throw.
 *
 * `props` may be omitted for events whose prop type is `Record<string, never>`
 * — every other event requires it, enforced at the call site.
 */
export function track<E extends AnalyticsEvent>(
  event: E,
  ...args: Record<string, never> extends AnalyticsEventProps[E]
    ? [props?: AnalyticsEventProps[E]]
    : [props: AnalyticsEventProps[E]]
): void {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "development") return;
  const [props] = args;
  // eslint-disable-next-line no-console
  console.log("[analytics]", event, props ?? {});
}
