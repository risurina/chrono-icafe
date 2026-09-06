/**
 * Product analytics — a thin, app-local abstraction over "an event happened".
 *
 * There is no analytics vendor in this repo. The point of this module is that
 * adding one is a change to `track()` alone: every call site already names a
 * closed event and a typed prop shape, so nothing else has to be revisited.
 *
 * Until then it logs in development and no-ops elsewhere. That is deliberately
 * the ONLY place in this app allowed to `console.log` (`.ai/rules/code-quality.md`).
 *
 * NOTE FOR ANOTHER PLAN TOUCHING THIS FILE: extend `AnalyticsEventProps` with
 * your events; never redefine or replace it. The union is closed on purpose so
 * a typo is a compile error, which also means two plans cannot each own their
 * own copy of it.
 *
 * KNOWN PENDING MERGE — the `two-sided-growth-loop` plan (under
 * `.ai/plans/chrono/`). That sibling plan, built in parallel in its own
 * worktree, creates this same file with its OWN closed union of seven DIFFERENT
 * events, none of which overlap the eight below:
 *
 *   PLAYER_SIGNUP, PLAYER_DISCOVERY_SEARCH, BUSINESS_VIEW,
 *   BUSINESS_INVITE_REQUEST, PARTNER_SIGNUP, PARTNER_CLAIM,
 *   PLAYER_CONNECTS_TO_BUSINESS
 *
 * Reconciling the two branches is therefore a UNION EXTENSION, not a rewrite:
 * concatenate that plan's seven entries into the `AnalyticsEventProps` map
 * below and keep one `track()`. `AnalyticsEvent` is derived from the map's keys
 * precisely so merging the maps merges the unions with no second edit.
 * `apply-for-tenant-prompt.tsx` is instrumented by both plans — expect a
 * conflict there too, and keep both calls if the events differ.
 */

/**
 * The per-event props map — the single source of truth for this app's event
 * vocabulary. Add events here; see the merge note above.
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
};

/**
 * The closed event-name union, DERIVED from the props map above rather than
 * declared separately — so extending the map is the only edit a merge needs.
 */
export type AnalyticsEvent = keyof AnalyticsEventProps;

/**
 * Record one event. Safe to call from any client component; a no-op on the
 * server, so a stray call from a server render cannot throw.
 */
export function track<E extends AnalyticsEvent>(
  event: E,
  props: AnalyticsEventProps[E],
): void {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "development") return;
  // eslint-disable-next-line no-console
  console.log("[analytics]", event, props);
}
