# Chrono Tenant Experience V2 — Gap Analysis & Delta Plan

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]
- Audit: (unclaimed)
- Implementation: email-theme-fixes-session (dispatched subagent, 2026-09-06)

## Source

A large product/UX spec ("Chrono Tenant Experience V2", 103 sections) was supplied by the
developer, describing a conversion-oriented, registry-driven, tenant-first public landing
page for gaming venues on Chrono, reusing live operational data (stations/rates) rather than
a second content copy.

## Headline finding: most of this spec is already built

Before drafting any implementation phases, Step 1 (Audit, as the spec itself mandates in its
own §95/§102) was run against the live `apps/chrono-web` + `apps/chrono-api` code and six
prior archived plans (`.ai/plans/chrono/archive/{chrono-landing,chrono-landing-rebuild,
saas-landing-rebuild,tenant-landing,chrono-landing-theme-presets,two-sided-growth-loop}`).
The overwhelming majority of the spec's asks are **already shipped**:

| Spec ask | Status | Where |
|---|---|---|
| Registry-based, tenant-configurable sections (§9, §31, §55, §101) | **Done** | `apps/chrono-web/src/components/landing/registry.ts` — 14 sections (`hero`, `stations`, `rates`, `experience`, `playerCta`, `specs`, `games`, `about`, `testimonials`, `events`, `contact`, `faq`, `share`, `cta`), built on `packages/agora`'s foundation `buildLandingSectionRegistry()`/`resolveLandingSections()`/`defineLandingSection()` (`.ai/rules/business-app.md`, "Tenant landing pages") |
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

Five things in the spec are **not** currently built. These are the only candidate phases
(Gap 4 is deferred to `future/`, not a phase of this plan — see below).

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

### Gap 5 — No sitemap.xml / robots.txt

Confirmed absent: `find apps/chrono-web/src/app -iname sitemap* -o -iname robots*` returns
nothing. Spec §93 explicitly asks for both. Additive — Next.js file-convention routes
(`sitemap.ts`/`robots.ts`), no schema change, no new API. Filed as Phase 4 below rather than
left as an open question, since the audit confirmed the gap is real.

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

- `chronoBranch` already has a `timezone` column (`apps/chrono-api/src/modules/branch/schema.ts:18`
  — `text("timezone").notNull().default("Asia/Manila")`), confirmed by audit. No timezone
  column needs to be added; `computeOpenStatus(hoursConfig, now, timezone)` uses this existing
  column as-is.
- Files: `apps/chrono-api/src/modules/branch/schema.ts` (new structured hours — recommend a
  `jsonb("hoursConfig")` column per `.ai/rules/database.md`'s "JSON only for metadata,
  never query-critical fields" — hours *rendering* is not query-critical, it's read once per
  page render and computed client/server-side, so jsonb is appropriate here, unlike e.g.
  station status), `apps/chrono-api/src/modules/branch/contracts.ts` (Zod schema for a
  day-of-week open/close structure; **decision, locked**: keep the existing `operatingHours`
  text column permanently as a tenant-editable supplementary note shown alongside the
  computed status, not deprecated — mirrors the existing `legacyLayer()` precedent in
  `apps/chrono-web/src/lib/landing.ts` of layering new structured data over an old flat
  column rather than replacing it), `apps/chrono-api/src/modules/branch/routes.ts`
  (`/public/venue-info` response gains the structured hours + computed status; the existing
  `PATCH /branches/:id` route, already gated `requirePermission(..., { branch: ["update"] })`
  at `apps/chrono-api/src/modules/branch/routes.ts:146-148`, is where `hoursConfig` writes go
  — no new permission action needed), `apps/chrono-web/src/components/landing/
  tenant-sections.tsx` (`TenantHero`/`TenantContact` render the computed status).

### Gap 2

- Files: `apps/chrono-web/src/lib/seo.ts` (new `tenantStructuredData()` helper, `LocalBusiness`
  shape sourced from already-fetched `venue`/`branding` data), the tenant page in
  `apps/chrono-web/src/app/(saas-landing)/page.tsx` (render the `<script>` tag). No schema
  change, no new API.

### Gap 3

- `AnalyticsEventProps` (`apps/chrono-web/src/lib/analytics.ts`) has **no shared base
  shape** — it's a map where each event key has its own independent props type
  (`TENANT_PAGE_VIEW: { tenantName; path }`, `PLAYER_LOGIN_FROM_TENANT: Record<string,
  never>`, etc.). "Add `source`" means adding `source?: string` to each individual event's
  props type that needs it (starting with `TENANT_PAGE_VIEW` and the downstream conversion
  events), not editing one shared type. Type-mechanics note: `track()`'s signature makes
  `props` optional only when `AnalyticsEventProps[E]` extends `Record<string, never>`
  exactly; adding `source?: string` to e.g. `PLAYER_LOGIN_FROM_TENANT` changes it from
  `Record<string, never>` to `{ source?: string }` — still all-optional, so `track(E)` with
  no second argument keeps compiling, but this should be verified with `pnpm typecheck`
  immediately after the type change, not assumed.
- The `/discover` → tenant-page link is **not** a `TrackedLink`: it's a plain `onVisit?:
  (organizationId: string) => void` callback prop on
  `apps/chrono-web/src/app/(apex-marketing)/discover/business-result-card.tsx:31-63`,
  invoked from `discover-search.tsx:148` as `onVisit={(organizationId) =>
  track("BUSINESS_VIEW", { organizationId })}`. Appending `?source=global_discovery` to the
  tenant URL happens in `business-result-card.tsx`'s actual href construction, not by
  editing a `TrackedLink` call site.
- Files: `apps/chrono-web/src/lib/analytics.ts`, `apps/chrono-web/src/app/(saas-landing)/
  page.tsx` (read `?source=` search param server-side, fall back to `"direct"`),
  `apps/chrono-web/src/app/(apex-marketing)/discover/business-result-card.tsx` (append
  `?source=global_discovery` to the tenant href), a small client helper to persist the
  resolved source in `sessionStorage` for same-session downstream events (mirrors the
  existing `TrackOnMount`/`TrackedLink` pattern in `analytics-bindings.tsx` — extend, don't
  replace).

## Phase Design

### Phase 1a — Dynamic open/closed status: schema, computation, read path (Gap 1)

**Files to update:** `apps/chrono-api/src/modules/branch/schema.ts`,
`apps/chrono-api/src/modules/branch/contracts.ts`, `apps/chrono-api/src/modules/branch/routes.ts`,
`apps/chrono-web/src/components/landing/tenant-sections.tsx`.

**Step-by-step tasks:**
1. Add `hoursConfig` jsonb column to `chronoBranch` (structured day/open/close, nullable —
   absent means "use legacy free-text display, no computed status"). No timezone column
   needed — `chronoBranch.timezone` already exists (`Asia/Manila` default).
2. Add Zod contract for the structure. **Locked decision**: `operatingHours` (free text)
   stays permanently as a tenant-editable supplementary note rendered alongside the computed
   status — it is never deprecated or removed.
3. Add a pure `computeOpenStatus(hoursConfig, now, timezone)` helper (unit-testable, no DB).
4. Surface computed status in `/public/venue-info`'s response.
5. Render `● OPEN NOW` / `● CLOSED — Opens at HH:MM` in `TenantHero`/`TenantContact`, falling
   back to the plain-text `operatingHours` display when `hoursConfig` is absent.
6. E2e spec (read path only): a branch with hours configured shows correct status at a
   mocked time; a branch with no `hoursConfig` falls back cleanly; cross-tenant isolation
   (tenant A's hours never leak into tenant B's computed status).

**Acceptance criteria:** `/public/venue-info` returns a computed status alongside the branch
data; the landing page displays it; a branch with no structured hours renders exactly as
today (no regression).

**Verification commands:** `pnpm typecheck`, `pnpm --filter @agora/chrono-api rls:proof`,
new e2e spec, `pnpm build`.

**Out-of-scope:** multi-timezone branches within one tenant beyond what the existing schema
already supports; holiday/exception-date hours (spec doesn't ask for this, don't add it); the
dashboard editor UI (Phase 1b).

**Execution start point:** `chronoBranch.hoursConfig` schema addition.

### Phase 1b — Dynamic open/closed status: dashboard hours editor (Gap 1)

**Files to update:** the tenant-admin branch/venue settings page in `apps/chrono-web`
(confirm exact path during implementation — the existing branch-settings page that already
edits `operatingHours`), wired to the existing `PATCH /branches/:id` route (gated
`requirePermission(c.var.tenant.permissions, { branch: ["update"] })`,
`apps/chrono-api/src/modules/branch/routes.ts:146-148` — no new permission action needed).

**Step-by-step tasks:**
1. Add a day-of-week open/close pairs editor (`agora/ui` primitives, per
   `.ai/rules/component-first-ui.md`) alongside the existing free-text `operatingHours` field.
2. Wire it to `hoursConfig` via the existing `PATCH /branches/:id` route.
3. E2e spec: a `staff`/`admin` can save structured hours; a role without `branch:update`
   is blocked (role-gate case, per `.ai/rules/e2e-testing.md`); saved hours reflect
   immediately in `/public/venue-info` on next read.

**Acceptance criteria:** a tenant admin can configure structured hours from the dashboard;
the role gate is enforced; the public page reflects the change without a deploy.

**Verification commands:** `pnpm typecheck`, new e2e spec, `pnpm build`.

**Out-of-scope:** nothing beyond the editor UI itself — Phase 1a already covers the read
path and computation.

**Execution start point:** the existing branch-settings page's `operatingHours` field.

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

**Out-of-scope:** sitemap generation, robots.txt (confirmed absent — see Phase 4, Gap 5,
below; not part of this phase).

**Execution start point:** `apps/chrono-web/src/lib/seo.ts`.

### Phase 3 — QR / source attribution (Gap 3)

**Files to update:** `apps/chrono-web/src/lib/analytics.ts`,
`apps/chrono-web/src/app/(saas-landing)/page.tsx`,
`apps/chrono-web/src/app/(apex-marketing)/discover/business-result-card.tsx`,
`analytics-bindings.tsx`.

**Step-by-step tasks:**
1. Add `source?: string` to each individual event's props type in `AnalyticsEventProps` that
   needs it (there is no shared base type — see Pass 2, Gap 3), starting with
   `TENANT_PAGE_VIEW` and the downstream conversion events; verify with `pnpm typecheck`
   immediately after.
2. Read `?source=` server-side on the tenant landing page, default `"direct"`.
3. Append `?source=global_discovery` to the tenant href built in
   `business-result-card.tsx` (its click handler is a plain `onVisit` callback, not a
   `TrackedLink` — see Pass 2, Gap 3).
4. Persist the resolved source for the session (sessionStorage) so a later `TENANT_SHARE` or
   `PLAYER_CONNECTS_TO_BUSINESS` click in the same visit carries the same value.
5. No vendor to send it to yet — this phase's acceptance criterion is that the *value* is
   correctly computed and attached to the existing dev-console log output, not that it
   reaches a real analytics backend (that's Gap 4 / future).

**Acceptance criteria:** landing page console-logs `TENANT_PAGE_VIEW` with the correct
`source` for a `?source=venue_qr` URL, for a `/discover`-referred visit, and for a bare direct
visit; a downstream event in the same session carries the same `source`.

**Verification commands:** `pnpm typecheck`, `pnpm build`, manual verification (dev console).

**Out-of-scope:** wiring a real analytics vendor (Gap 4, blocked on a vendor decision).

**Execution start point:** `apps/chrono-web/src/lib/analytics.ts`.

### Phase 4 — Sitemap and robots.txt (Gap 5)

**Files to update:** new `apps/chrono-web/src/app/sitemap.ts`, new
`apps/chrono-web/src/app/robots.ts` (Next.js file-convention routes).

**Step-by-step tasks:**
1. `robots.ts`: allow indexing of published tenant landing pages and the apex marketing
   site; disallow `/dashboard`, `/portal`, `/admin` surfaces.
2. `sitemap.ts`: list the apex marketing routes plus every tenant with a **published**
   landing page (same predicate `/public/discover/businesses` already uses — published +
   non-terminal status) — never an unpublished or suspended tenant.
3. Confirm host-aware behavior: a request to a tenant subdomain/custom domain should not
   serve the apex's sitemap/robots and vice versa (mirrors the existing host-aware
   `generateMetadata()` pattern in `layout.tsx`).

**Acceptance criteria:** `/sitemap.xml` lists only published tenants + apex routes;
`/robots.txt` disallows authenticated surfaces; both are host-aware.

**Verification commands:** `pnpm typecheck`, `pnpm build`, manual check of both routes on
apex and a tenant host.

**Out-of-scope:** structured data (Phase 2 already covers this).

**Execution start point:** `apps/chrono-web/src/app/robots.ts`.

## Explicitly Out of Scope For This Plan

- Everything in the "Already built" table — no phase touches it.
- Gap 4 (tenant success dashboard) — `future/`, blocked on an analytics-vendor decision the
  developer hasn't made yet.
- Any rewrite of the registry/section system itself (spec §55/§101 both explicitly say don't
  rewrite what's directionally correct, and research confirms it already matches the spec's
  own described shape).
- Custom domains, reservations, loyalty, personalization (spec's own §77 Phase 3 items) —
  already flagged by the spec itself as later-phase, not part of this document.

## Resolved During Audit

1. Sitemap/robots confirmed absent — filed as Gap 5 / Phase 4 above (was left as an open
   question in the initial draft).
2. `chronoBranch.timezone` confirmed to already exist (`Asia/Manila` default) — Phase 1a's
   scope does not include adding a timezone column.

## Open Question For Developer

1. Confirm whether wiring a real analytics vendor is wanted at all before Gap 4 (tenant
   success dashboard) is filed as a `future/` plan, or whether it should stay permanently out
   of scope (some teams intentionally avoid third-party analytics SDKs for privacy reasons —
   `analytics.ts`'s own doc comment about "no PII in event props by design" suggests this may
   be a deliberate constraint, not an oversight).
