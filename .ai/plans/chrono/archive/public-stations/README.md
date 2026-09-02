# Chrono — `public-stations` module

**Depends on:** `stations` (plan done, committed `557b43e`; Phases 1–2 implemented —
`ChronoStationGroups`/`ChronoStations` schema + RLS migrated; this plan only reads that
schema, no dependency on stations' unbuilt Phases 3–5). No dependency on `sessions`
(not implemented) or `devices` (not implemented) — see "Deliberately narrowed" below for
what that costs us versus prior art.

This is Chrono's **first genuinely public, non-dashboard, non-portal surface** — no
session, no membership, reachable by anyone who knows a tenant's host. It is also the
first plan under this migration that must add a "Public tenant surface" row to
`apps/chrono-api/AGENTS.md`'s Surfaces section (done as part of Phase 1 below, not
assumed).

## What this is

A venue's public live-availability page — "3 of 10 PCs free at Acme Gaming" — reachable
at `{tenantSlug}.CHRONO_DOMAIN/stations` with no sign-in. A prospective walk-in customer
checks it before heading over; a venue can link it from social media or a QR code at the
door.

## Pass 1 — Workflow Analysis

- **Who uses this**: an anonymous public visitor — no `member`, no `tenantMember`
  session, no platform admin. Purely informational.
- **Workflow**: visitor hits `{tenantSlug}.CHRONO_DOMAIN/stations` (or a verified custom
  domain's `/stations`) → page resolves the tenant from the host → shows an aggregate
  summary ("7 available / 3 in use / 10 total") and, below it, a simple per-station grid
  (station name/number + status badge only). No login, no CTA beyond maybe a link back
  to the tenant's own landing page (plan #3) if it exists.
- **What they see/click**: nothing to click for the core view — read-only. The page
  auto-refreshes (short client-side poll) so the numbers stay roughly live without a
  websocket.
- **Failure cases**:
  - Unknown/unresolvable host → `getRequestTenant()` returns no tenant → 404, not a
    500 or an empty dashboard-shaped page.
  - A suspended/archived tenant → same 404 treatment as an unknown host; a suspended
    venue's public page must not silently keep serving live station data.
  - No stations yet (new tenant) → empty-state message ("Station availability isn't set
    up yet"), not an error.
  - **Tenant-isolation leak**: tenant A's page must never be able to see or aggregate
    tenant B's stations. Because there is no session/membership to derive tenant from,
    the ONLY input is the resolved host — never a client-supplied tenant id/slug in the
    request body, query string, or a hidden form field.
  - **Abuse**: an unauthenticated, cacheable, DB-backed endpoint is a scraping/DoS
    target. Addressed below (rate limiting + short-TTL cache).
- **Audit/notifications**: none. This is a read-only public surface; no audit event is
  warranted for an anonymous GET (mirrors `/health` and other public/unauthenticated
  probes elsewhere in the platform, which also aren't audited).

## Pass 2 — Technical Planning

### Divergence from prior art (read first)

Prior art (`public-stations/routes.ts` + `service.ts`, oikos) is useful for *what* to
show, not *how* to build it — several of its choices are exactly the mistakes this
plan's constraints exist to prevent:

1. **Tenant resolution is a route param + a raw DB lookup**
   (`c.req.param('tenantSlug')` → `db.query.Tenant.findFirst(...)`), not a host parse.
   That's a request-shape choice oikos's router allowed; on Agora it would also be a
   layering violation — tenant identity here MUST come from `getRequestTenant()`'s host
   parse (`agora/next`), the exact same primitive the authenticated dashboard uses, with
   **no Next.js middleware** (`.ai/rules/architecture.md`). This plan's Phase 1 explicitly
   does not introduce a path-param or query-string tenant identifier anywhere.
2. **No rate limiting, no cache, hits the database on every request** — three separate
   queries (stations+branch+device join, reservation aggregation, pricing-rule scan)
   fully re-executed per anonymous hit, with zero abuse protection. This is the textbook
   "public read endpoint someone scrapes into a DB-load incident" shape. This plan adds
   both a short in-memory per-tenant TTL cache and an IP-based rate limit (see below) —
   neither existed in oikos.
3. **Over-exposure**: oikos's public payload includes `currentPricingRuleName`,
   `hourlyRate`, session type/label, and reservation queue/hold detail per station — real
   commercial and operational detail for a page nobody has to authenticate to see, and a
   forward-looking coupling this pass doesn't want (pricing/reservation modules are
   already landed in Chrono, but this plan deliberately does NOT reach into them — see
   "Deliberately narrowed"). This plan's public payload is aggregate counts plus a
   minimal per-station status badge only — no rate, no pricing-rule name, no reservation
   queue length. A venue that wants richer public detail is a follow-up, not this pass's
   default.
4. **oikos's `PricingRule` best-rate scoring logic lives inline in the service function**
   — a chunk of business logic with no test coverage in the file we can see. Not
   reproduced at all in this pass, both because station-level pricing beyond the flat
   `hourlyRate`/`memberRate` fields doesn't exist yet in Chrono-on-Agora (see the
   `stations` plan's "Deliberately narrowed") and because a public page is the wrong
   place to introduce a pricing-resolution code path for the first time.
5. **One thing prior art got right and this plan keeps**: serving a short in-memory
   cache is the correct instinct for a public read endpoint — oikos just applied it to
   the wrong endpoint (`public-releases`, see plan #2) and not this one. This plan
   applies that same instinct here instead.

### Host resolution (no middleware)

- Server component at `apps/chrono-web/src/app/stations/page.tsx`, rendered under the
  tenant-host route tree exactly like `dashboard/*` — reads `getRequestTenant()`
  (`agora/next`) to resolve `{ tenantId, tenantSlug }` from the incoming `host` header. No
  membership check, no session read — `getRequestTenant()` only needs the host parse
  half of what it does for the dashboard.
- If `getRequestTenant()` returns no tenant, or the resolved tenant's `status` is a
  terminal state (`suspended`/`cancelled`/`archived`/`deleting` — reusing the vocabulary
  from `.ai/rules/rbac.md`'s Organizations section), render Next's `notFound()`. A
  suspended tenant's public page must read as "doesn't exist," not "here's stale data."
- The page calls a new **public** (no-auth) `/rpc/public/stations` route — mounted
  outside `tenantMiddleware()` (which requires a session), reading the tenant from the
  same host-resolved value the page already has, passed through as a plain query param
  derived server-side from the resolved host — never a client-editable one. Concretely:
  the Next.js server component calls the API directly server-side (RSC → API, not
  browser → API), so the tenant slug never appears as user-editable request state at
  all; the browser gets fully-rendered HTML plus a small polling client component that
  re-hits the *same* Next.js route handler (not the Chrono API directly), which
  re-resolves the host server-side on every poll. This keeps tenant resolution
  exclusively server-side and host-derived on every single request, matching
  `.ai/rules/tenant.md`'s "never trust client-supplied tenant" rule even though there's
  no session here to misuse.

### API surface

- `apps/chrono-api/src/modules/station/routes.ts` gains one additional route, mounted
  separately from the tenant-gated station CRUD routes: `GET /rpc/public/stations`
  (new top-level mount in `apps/chrono-api/src/routes/rpc.ts` — a small
  `publicStationRoutes()` factory exported from the station module, composed
  **outside** `tenantMiddleware()`, parallel to how `agora/platform-admin/routes` composes
  outside it for a different reason).
- Request: `{ tenantSlug: string }` as a query param, but this value is validated against
  the DB-resolved tenant the same way the web page does — the route itself re-derives
  tenant identity by looking up `organization` by slug (case-sensitive exact match, no
  wildcard), the RPC-layer equivalent of `getRequestTenant()`'s slug branch. This is
  *not* "trusting client input for isolation" — the DB lookup, not the input string, is
  what determines which tenant's rows get read, and there is no session/permission
  context that a forged slug could escalate into; worst case a wrong slug returns 404,
  identical to hitting an unknown tenant subdomain directly.
- Query, scoped by the resolved `tenantId` via `withTenant(tenantId, tx => …)` — RLS
  still applies; "public" means no authentication, not "skip RLS." Selects only
  `chronoStation.status` grouped into the aggregate counts plus a minimal per-row shape:
  `{ id, name, stationNumber, status }`. No branch join, no pricing, no session/
  reservation join (those modules aren't reachable from an unauthenticated read in this
  pass — see Out of Scope).
- Status mapping to a small public-facing vocabulary — reuse `chronoStation.status`
  verbatim (`available` | `maintenance` | `offline`, plus the reserved `occupied` value
  documented in the `stations` schema for `sessions`/`devices` to set later) rather than
  inventing a second enum; the public page renders whatever the admin-set status is
  today, including `occupied` once a later module starts setting it — no plan-specific
  translation layer to maintain.
- **No new permission resource.** Reasoned explicitly, per the hard constraints: this is
  a public read with no actor to gate — there is no `c.var.tenant.permissions` to check
  against because there is no tenant context/session at all. `requirePermission` is not
  applicable here, and inventing a permission with nothing to deny would violate
  `.ai/rules/rbac.md`'s "every statement maps to a real gate" rule in the opposite
  direction (a gate with no actor).

### Abuse prevention (new vs. prior art)

- **Rate limiting**: reuse the platform's existing IP-based rate-limit middleware
  pattern (the one already fronting `/auth/*` per `.ai/rules/auth.md`'s "Sign-in methods"
  section, "a dedicated middleware... above the rate limiter") — apply the same
  primitive to this one new public route, keyed by requester IP, generous enough for a
  legitimate polling client (e.g. 1 req/3s per IP) but bounded. This is Phase 1 scope for
  *this* route only — not a general public-API rate-limit rollout.
- **Caching**: a short (5–10s) in-memory per-tenant cache inside the route handler,
  mirroring oikos's own `public-releases` cache shape (`Map<tenantId, { data, at }>`)
  but applied to the endpoint that actually needs it. A single Node process is the
  deployment model here (`.ai/rules/api.md` — "long-lived Node server"), so an in-memory
  cache is coherent within that process; no cross-instance cache invalidation problem to
  solve in this pass.
- Client polling interval (student page component) is deliberately longer than the cache
  TTL (e.g. poll every 15s against a 5–10s cache) so most polls are cache hits.

### Schema

No new tables. Reads `chronoStation` (and, only for the aggregate count, nothing else)
via `withTenant`. No migration in this plan.

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Public station view | — | `GET /rpc/public/stations` (unauth, rate-limited, cached) | — | — |

- No mutations exist on this surface — read-only by design. No soft-delete concern.
- No toast/error feedback contract in the usual mutating-action sense; the page's only
  failure states are "tenant not found" (404) and a transient fetch error on the client
  poller (silently keep showing the last good data rather than flashing an error toast
  on every missed poll — a public page should degrade quietly).
- No audit linkage — nothing here is a sensitive confirmed action.

### Web UI

- `apps/chrono-web/src/app/stations/page.tsx` — server component, calls
  `getRequestTenant()`, renders `notFound()` on no/terminal tenant, otherwise renders the
  summary + grid using `agora/ui` primitives (`Card`, `Badge` for status) —
  `.ai/rules/component-first-ui.md` applies here exactly as everywhere else; this being
  "public" is not an excuse for raw HTML.
- A small client component (`StationAvailabilityPoller` or similar) wraps the
  server-rendered initial data and re-fetches on an interval via a route handler under
  `apps/chrono-web/src/app/api/public-stations/route.ts` (a thin same-origin proxy to
  the Chrono API's public route, so the browser never needs the API's own base URL/CORS
  exposure for an anonymous surface) — or, if simpler, calls the Chrono API's public
  route directly with CORS opened only for this one path. Pick same-origin proxy by
  default; document the choice in the phase's own notes if changed during
  implementation.
- No nav entry — this route is reachable only by direct link/QR, not linked from the
  dashboard shell (it's for the public, not staff).

### Surfaces doc update (`apps/chrono-api/AGENTS.md`)

Phase 1 adds a new row/paragraph to that file's "Surfaces" section, naming:
`{tenantSlug}.CHRONO_DOMAIN/stations` (and the matching verified-custom-domain form) —
public, unauthenticated, resolved via `getRequestTenant()`, no membership required. This
plan does not proceed past Phase 1 without that edit landing in the same phase.

## Out of Scope (this plan)

- Per-station pricing/rate display (no pricing engine reachable from a public,
  unauthenticated context in this pass — see Divergence #3).
- Reservation queue/hold overlay on station status (depends on exposing `reservation`
  data publicly, a separate decision from showing raw station status — not bundled into
  this plan).
- Live push/websocket updates (`chrono-realtime-updates` is explicitly deferred
  platform-wide per the migration handover; this plan uses polling only).
- Device/session-derived detail (scheduled end time, connectivity) — `devices` and
  `sessions` aren't implemented; `chronoStation.status` alone drives this page.
- A general-purpose public rate-limiting framework — only this one route gets it in
  this pass.

## Phase 1 — Public route, host resolution, Surfaces doc, web page

**Files to Update**
- `apps/chrono-api/src/modules/station/routes.ts` (add `publicStationRoutes()` factory)
- `apps/chrono-api/src/routes/rpc.ts` (mount it outside `tenantMiddleware()`)
- `apps/chrono-api/AGENTS.md` (Surfaces section — new public-surface row)
- `apps/chrono-web/src/app/stations/page.tsx` (new)
- `apps/chrono-web/src/app/api/public-stations/route.ts` (new, same-origin proxy)

**Step-by-Step Tasks**
1. Add the public route factory to the station module: resolve tenant by slug via
   `adminDb`/a plain `organization` lookup (not `withTenant`, since there's no tenant
   context yet at that point), reject terminal-status tenants with 404, then read
   stations via `withTenant(tenantId, …)`.
2. Add the 5–10s in-memory cache and the IP rate-limit middleware to that route only.
3. Mount the route in `rpc.ts` outside `tenantMiddleware()`, confirm it does not
   accidentally inherit any auth-gated composition.
4. Add the Surfaces row to `apps/chrono-api/AGENTS.md`.
5. Build the Next.js page + same-origin proxy route + polling client component using
   `agora/ui` primitives only.
6. Empty-state and 404 paths render correctly (no stations yet; unknown host; suspended
   tenant).

**Acceptance Criteria**
- Visiting `{tenantSlug}.localtest.me:3000/stations` with no session shows the
  aggregate + grid for that tenant's real `chronoStation` rows.
- Visiting an unknown or a suspended tenant's `/stations` renders a 404, not a 500 or
  another tenant's data.
- A second tenant's `/stations` never shows the first tenant's stations (cross-tenant
  isolation, proven in the e2e spec below).
- Rapid repeated requests from one IP are throttled; the cache measurably avoids a DB
  hit on every poll (verified by a log/counter during manual testing, not necessarily
  asserted in the e2e spec itself).
- `apps/chrono-api/AGENTS.md` documents the new surface.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` (no schema/RLS change in this plan, but
  re-run since it touches a tenant-scoped read path)

**Out-of-Scope**
- Everything under this plan's "Out of Scope" section above.

**Execution Start Point**
- Read `apps/chrono-api/src/modules/station/routes.ts` and
  `apps/chrono-api/src/routes/rpc.ts` in full before adding the new factory; read
  `apps/agora-web/src/lib/rpc.ts`'s host-derivation pattern before writing the Next.js
  proxy route.

## Phase 2 — E2E spec

**Files to Update**
- `apps/chrono-web/e2e/tests/public-stations/availability.spec.ts` (new)

**Step-by-Step Tasks**
1. Seed two tenants (A, B) each with a small set of `chronoStation` rows in known
   statuses via the existing seed/test-data helpers used by other Chrono e2e specs.
2. Happy path: visiting tenant A's `/stations` with no session shows the correct
   aggregate counts and per-station statuses for A only.
3. "Public accessibility without a session" in place of a role gate: assert the page
   renders fully with **no** authentication step anywhere in the flow — this is the
   public-page equivalent of the mandatory role-gate assertion.
4. Cross-tenant isolation: assert tenant B's stations never appear on tenant A's page
   and vice versa.
5. Unknown-host / suspended-tenant 404 case.

**Acceptance Criteria**
- All four assertions above pass; the spec fails if any station row from the wrong
  tenant leaks into the DOM.

**Verification Commands**
- The Chrono web Playwright suite command used by other landed Chrono modules'
  specs (see an existing spec under `apps/chrono-web/e2e/tests/` for the exact runner
  invocation — `pnpm dev` must be running first per `.ai/rules/rbac.md`'s Testing
  section's manual-e2e note).

**Out-of-Scope**
- Load/abuse testing the rate limiter itself (manual verification only, per Phase 1).

**Execution Start Point**
- Copy the structure of an existing Chrono e2e spec (e.g. under
  `apps/chrono-web/e2e/tests/branches/` or `stations/` if one already exists) for
  seeding conventions before writing new ones.

## Open Questions (developer to confirm/override)

1. Same-origin Next.js proxy route vs. opening CORS on the Chrono API for this one
   public path — this plan defaults to the proxy; flip if the developer prefers a direct
   browser→API call.
2. Exact rate-limit numbers (this plan proposes ~1 req/3s per IP) — tune during
   implementation against the shared auth rate-limiter's existing config rather than
   inventing new constants from scratch.
3. Whether `occupied`-status stations (once `sessions`/`devices` exist) should still
   show on this public page at all, or be folded into "in use" — deferred to whichever
   plan first makes `sessions` set that status; this plan's grid renders whatever status
   string exists today with no special-casing.

## After Implementation

Completion report per `.ai/rules/feature-planning.md`: Summary, Files changed, Commands
run, typecheck/rls:proof result, e2e result, What was not implemented (see Out of
Scope), Known risks (in-memory cache/rate-limit is single-process — revisit if Chrono
ever scales the API horizontally), Next recommended task.
