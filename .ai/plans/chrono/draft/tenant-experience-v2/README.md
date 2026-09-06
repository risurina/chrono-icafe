# Chrono Tenant Experience V2 — Gap Analysis & Delta Plan

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]
- Audit: (unclaimed)
- Implementation: (unclaimed)

## Source

A large product/UX spec ("Chrono Tenant Experience V2", 103 sections) was supplied by the
developer, describing a conversion-oriented, registry-driven, tenant-first public landing
page for gaming venues on Chrono, reusing live operational data (stations/rates) rather than
a second content copy.

## Headline finding: most of this spec is already built

Before drafting any implementation phases, Step 1 (Audit, as the spec itself mandates in its
own §95/§102) was run against the live `apps/chrono-web` + `apps/chrono-api` code and five
prior archived plans (`.ai/plans/chrono/archive/{chrono-landing,chrono-landing-rebuild,
saas-landing-rebuild,tenant-landing,chrono-landing-theme-presets,two-sided-growth-loop}`).
The overwhelming majority of the spec's asks are **already shipped**:

| Spec ask | Status | Where |
|---|---|---|
| Registry-based, tenant-configurable sections (§9, §31, §55, §101) | **Done** | `apps/chrono-web/src/components/landing/registry.ts` — 13 sections (`hero`, `stations`, `rates`, `experience`, `playerCta`, `specs`, `games`, `about`, `testimonials`, `events`, `contact`, `faq`, `share`, `cta`), built on `packages/agora`'s foundation `buildLandingSectionRegistry()`/`resolveLandingSections()`/`defineLandingSection()` (`.ai/rules/business-app.md`, "Tenant landing pages") |
| Live station availability, sourced from the real operational table (§13-16, §34, §51) | **Done** | `TenantStations` section + hero gauges, both reading `GET /public/stations` (`apps/chrono-api/src/modules/station/routes.ts`), RLS-enforced via `withTenant` (not bypassed), 10s cache |
| Rates, derived from real tenant data, zero/invalid hidden (§18-19) | **Done** | `TenantRates` section reading `GET /public/venue-info` → `chronoStationGroup.hourlyRate`/`memberRate`; `toRateCards()` explicitly drops zero-priced groups, no fabricated pricing |
| Location/hours/directions/map, no raw DB leakage (§22, §52-54) | **Done** | `TenantContact` component (`id="location"`, heading "Find us") — address, hours, phone, email, embedded map derived from address (no API key needed) |
| Player-connect CTA reusing the global-customer/tenantMember bridge, not a new model (§24-25, §81) | **Done** | `PlayerCtaActions` + `ApplyForTenantPrompt`, calling the foundation's `createCustomerApplyRoutes()` `POST /apply` — instant access, exactly as `.ai/rules/business-app.md` already specifies |
| "Business not found → request this business" demand capture (§45-48, §82-84) | **Done** | `ChronoBusinessLeads` table (platform-global, no RLS by design) + `businessLeadPublicRoutes()`, discovery page auto-opens the invite form on a zero-match search |
| Global discovery integration, tenant cards with live availability (§35-37, §86) | **Done** | `/discover` page, `GET /public/discover/businesses` (cross-tenant `withAdmin`, explicit predicates: published landing page + non-terminal status) |
| SEO title/description/OG/canonical, tenant-specific (§39, §41) | **Done** | `apps/chrono-web/src/lib/seo.ts`'s `tenantPageMetadata()`, host-aware `generateMetadata()` |
| Tenant branding/theme presets, tenant color wins at equal specificity (§29-30, §58-59) | **Done** | `themePresetCss()` then `brandingCss()` injection order in `layout.tsx`, matching the documented precedence rule |
| Analytics event taxonomy for the conversion funnel (§43, §65-66, §85) | **Partially done** | `apps/chrono-web/src/lib/analytics.ts` already defines `TENANT_PAGE_VIEW`, `TENANT_STATIONS_VIEW`, `STATION_AVAILABILITY_INTERACTION`, `CONTACT_CLICK`, `DIRECTIONS_CLICK`, `TENANT_SHARE`, `PLAYER_SIGNUP_FROM_TENANT`, `PLAYER_LOGIN_FROM_TENANT`, `PLAYER_CONNECTS_TO_BUSINESS`, plus discovery events — but `track()` is a dev-only `console.log`, no real vendor wired (**intentional**, per the file's own doc comment — not a defect) |

**Recommendation: do not re-plan or rebuild any of the above.** Re-implementing an
already-shipped, already-reviewed system because a spec re-describes it from first principles
would violate `.ai/rules/ai-agent.md` ("do not create business-specific modules... bloat") and
the developer's own standing feedback (`[[feedback_improve_dont_port_prior_art]]`-adjacent
principle: build on what exists, don't restate it as new work).

## Genuine gaps

Four things in the spec are **not** currently built. These are the only candidate phases.

### Gap 1 — No structured operating hours / dynamic open-closed status

`chronoBranch.operatingHours` (`apps/chrono-api/src/modules/branch/schema.ts:21`) is a single
free-text column (`text("operatingHours")`, capped 255 chars in the contract). The spec's
§23 "Dynamic Open/Closed Status" (`● OPEN NOW` / `● CLOSED — OPENS AT 10:00 AM`) requires
*parseable* hours, not display text. This is a genuine schema change.

### Gap 2 — No structured data (JSON-LD) for SEO

Confirmed via grep: no `application/ld+json`, no `LocalBusiness` schema anywhere in
`apps/chrono-web/src`. Spec §40/§93 ask for `LocalBusiness`/`EntertainmentBusiness` structured
data. Additive — no schema change, a new server-rendered `<script type="application/ld+json">`
in the tenant landing page using data already fetched (venue info + branding).

### Gap 3 — No QR-code / traffic-source attribution

Confirmed via grep: no `venue_qr`, `utm_source`, or `source` property on any analytics event.
Spec §86-89 want a `source` dimension (`global_discovery`/`google`/`facebook`/`qr_code`/
`direct`/`share`) attached to `TENANT_PAGE_VIEW` and downstream events, so venue-placed QR
codes can be measured against other channels. Additive to the existing `AnalyticsEventProps`
union — no new infra, since the event taxonomy already exists (just an added `source` field on
existing events + a `?source=` query param read on landing).

### Gap 4 — No tenant-facing conversion/success dashboard

Spec §67 wants a partner-portal "Website Performance" panel (visitors, availability views,
start-playing clicks, connections, conversion %). This is genuinely new **and blocked on
Gap 3 and a real analytics vendor** — you cannot show a conversion dashboard sourced from a
`console.log` no-op. Treat as `future/`, not a phase of this plan, until an analytics vendor
decision is made (out of scope for this plan; see Open Question below).

## Pass 1 — Workflow Analysis (gaps only)

**Gap 1 (open/closed status).** A visitor lands on a tenant page outside business hours and
should immediately see `● CLOSED — Opens at 10:00 AM` instead of just a hours string they have
to parse themselves. Failure cases: a branch with no structured hours configured yet (fall
back to showing the existing free-text string, never a fabricated status); a branch open 24
hours (always show `● OPEN NOW`, no "opens at" line); multi-branch tenants (status is
per-branch, no single tenant-wide status if branches differ).

**Gap 2 (structured data).** No visible UI change — search engines and link-unfurlers (Google,
Facebook) read the JSON-LD block. Failure case: a tenant with no address/branding configured
should emit a minimal valid schema, never a schema with fabricated/empty-string fields that
could read as spam to a crawler.

**Gap 3 (source attribution).** A player scans a QR code placed in the venue → lands with
`?source=venue_qr` → `TENANT_PAGE_VIEW` fires with `source: "venue_qr"` → conversion events
downstream in the same session (Start Playing, Connect) get the same `source` value stamped
via a session-scoped value (e.g. sessionStorage), joinable later once a real analytics vendor
is wired.

## Pass 2 — Technical Planning

### Gap 1

- Files: `apps/chrono-api/src/modules/branch/schema.ts` (new structured hours — recommend a
  `jsonb("hoursConfig")` column per `.ai/rules/database.md`'s "JSON only for metadata,
  never query-critical fields" — hours *rendering* is not query-critical, it's read once per
  page render and computed client/server-side, so jsonb is appropriate here, unlike e.g.
  station status), `apps/chrono-api/src/modules/branch/contracts.ts` (Zod schema for a
  day-of-week open/close structure, keep `operatingHours` text column as a legacy display
  fallback per the existing `legacyLayer()` precedent in `apps/chrono-web/src/lib/landing.ts`),
  `apps/chrono-api/src/modules/branch/routes.ts` (`/public/venue-info` response gains the
  structured hours; a small pure helper computes open/closed from `hoursConfig` + branch
  timezone — **confirm timezone handling during implementation**, since the branch schema's
  current timezone story is unconfirmed and must be checked before this phase starts),
  `apps/chrono-web/src/components/landing/tenant-sections.tsx` (`TenantHero`/`TenantContact`
  render the computed status).
- This is a schema change → plan-first is already satisfied by this document, but the
  Concreteness Gate needs the timezone question resolved before it can move to `ready/`.

### Gap 2

- Files: `apps/chrono-web/src/lib/seo.ts` (new `tenantStructuredData()` helper, `LocalBusiness`
  shape sourced from already-fetched `venue`/`branding` data), the tenant page in
  `apps/chrono-web/src/app/(saas-landing)/page.tsx` (render the `<script>` tag). No schema
  change, no new API.

### Gap 3

- Files: `apps/chrono-web/src/lib/analytics.ts` (`source` field added to `AnalyticsEventProps`'
  base shape), `apps/chrono-web/src/app/(saas-landing)/page.tsx` (read `?source=` search param
  server-side, fall back to `"direct"`), a small client helper to persist it in
  `sessionStorage` for same-session downstream events (mirrors the existing `TrackOnMount`/
  `TrackedLink` pattern in `analytics-bindings.tsx` — extend, don't replace).

## Phase Design

### Phase 1 — Dynamic open/closed status (Gap 1)

**Files to update:** see Pass 2, Gap 1 above.

**Step-by-step tasks:**
1. Confirm branch timezone handling (does `chronoBranch` have a timezone column today? — if
   not, this phase must add one, which changes its scope; resolve before implementation).
2. Add `hoursConfig` jsonb column (structured day/open/close, nullable — absent means "use
   legacy free-text display, no computed status").
3. Add Zod contract for the structure; validate on the branch-settings write path.
4. Add a pure `computeOpenStatus(hoursConfig, now, timezone)` helper (unit-testable, no DB).
5. Surface computed status in `/public/venue-info`'s response.
6. Render `● OPEN NOW` / `● CLOSED — Opens at HH:MM` in `TenantHero`/`TenantContact`, falling
   back to the plain-text `operatingHours` display when `hoursConfig` is absent.
7. Add dashboard editor UI for structured hours (day-of-week open/close pairs) alongside the
   existing free-text field — decide whether free-text is deprecated or kept as a
   supplementary note (recommend: keep both, free-text becomes an optional note under the
   structured hours).
8. E2e spec: a branch with hours configured shows correct status at a mocked time; a branch
   with no `hoursConfig` falls back cleanly; cross-tenant isolation (tenant A's hours never
   leak into tenant B's computed status).

**Acceptance criteria:** `/public/venue-info` returns a computed status alongside the branch
data; the landing page displays it; a branch with no structured hours renders exactly as
today (no regression); `pnpm typecheck` + `rls:proof` (table already RLS-forced, unaffected)
pass.

**Verification commands:** `pnpm typecheck`, `pnpm --filter @agora/chrono-api rls:proof` (or
the chrono-api-scoped equivalent — confirm the exact filter name during implementation),
new e2e spec, `pnpm build`.

**Out-of-scope:** multi-timezone branches within one tenant beyond what the existing schema
already supports; holiday/exception-date hours (spec doesn't ask for this, don't add it).

**Execution start point:** confirm branch timezone story (task 1) before touching schema.

### Phase 2 — SEO structured data (Gap 2)

**Files to update:** `apps/chrono-web/src/lib/seo.ts`,
`apps/chrono-web/src/app/(saas-landing)/page.tsx`.

**Step-by-step tasks:**
1. Add `tenantStructuredData(venue, branding, seo)` returning a `LocalBusiness` (or
   `EntertainmentBusiness`, pick the closer-fitting schema.org type — confirm during
   implementation which fields Chrono's data actually supports) JSON object, omitting any
   field with no real data rather than emitting an empty string.
2. Render it as `<script type="application/ld+json">{JSON.stringify(...)}</script>` in the
   tenant branch of the landing page.
3. Validate output with Google's Rich Results Test manually against the IZUR reference tenant.

**Acceptance criteria:** valid JSON-LD renders only on tenant hosts (never apex), passes
Rich Results Test with no errors, no fabricated fields for a tenant missing optional data.

**Verification commands:** `pnpm typecheck`, `pnpm build`, manual Rich Results Test.

**Out-of-scope:** sitemap generation, robots.txt changes (spec §93 mentions these but no gap
was found — confirm sitemap/robots already exist before assuming this is in scope; if they
don't exist, that's a fifth gap to add here during audit, not assumed now).

**Execution start point:** `apps/chrono-web/src/lib/seo.ts`.

### Phase 3 — QR / source attribution (Gap 3)

**Files to update:** `apps/chrono-web/src/lib/analytics.ts`,
`apps/chrono-web/src/app/(saas-landing)/page.tsx`, `analytics-bindings.tsx`.

**Step-by-step tasks:**
1. Add `source?: string` to the shared analytics event base shape.
2. Read `?source=` server-side on the tenant landing page, default `"direct"`; recognize
   `global_discovery` as the referrer when arriving from `/discover`'s "View Venue" link
   (already a `TrackedLink` — confirm it can pass a `source` query param without changing its
   public API).
3. Persist the resolved source for the session (sessionStorage) so a later `TENANT_SHARE` or
   `PLAYER_CONNECTS_TO_BUSINESS` click in the same visit carries the same value.
4. No vendor to send it to yet — this phase's acceptance criterion is that the *value* is
   correctly computed and attached to the existing dev-console log output, not that it
   reaches a real analytics backend (that's Gap 4 / future).

**Acceptance criteria:** landing page console-logs `TENANT_PAGE_VIEW` with the correct
`source` for a `?source=venue_qr` URL, for a `/discover`-referred visit, and for a bare direct
visit; a downstream event in the same session carries the same `source`.

**Verification commands:** `pnpm typecheck`, `pnpm build`, manual verification (dev console).

**Out-of-scope:** wiring a real analytics vendor (Gap 4, blocked on a vendor decision).

**Execution start point:** `apps/chrono-web/src/lib/analytics.ts`.

## Explicitly Out of Scope For This Plan

- Everything in the "Already built" table — no phase touches it.
- Gap 4 (tenant success dashboard) — `future/`, blocked on an analytics-vendor decision the
  developer hasn't made yet.
- Any rewrite of the registry/section system itself (spec §55/§101 both explicitly say don't
  rewrite what's directionally correct, and research confirms it already matches the spec's
  own described shape).
- Custom domains, reservations, loyalty, personalization (spec's own §77 Phase 3 items) —
  already flagged by the spec itself as later-phase, not part of this document.

## Open Question For Audit

1. Confirm whether `apps/chrono-web` already has a sitemap/robots.txt setup — if it does,
   Phase 2's "out of scope" note is correct; if it doesn't, decide whether to fold it into
   Phase 2 or file a fifth gap.
2. Confirm `chronoBranch`'s current timezone story before Phase 1 is moved to `ready/` — this
   directly affects Phase 1's scope and file list.
3. Confirm whether wiring a real analytics vendor is wanted at all before Gap 4 is filed as a
   `future/` plan, or whether it should stay permanently out of scope (some teams intentionally
   avoid third-party analytics SDKs for privacy reasons — `analytics.ts`'s own doc comment
   about "no PII in event props by design" suggests this may be a deliberate constraint, not
   an oversight).
