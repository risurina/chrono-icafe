# Chrono — white-label tenant site (player acquisition rebuild)

**Sessions:**
- Planning: tenant-white-label-site-planning [8c0127] (session id
  `8c012759-8626-4281-b096-158dd99eb7b5`; `ListAgents` was not available as a
  tool in this session to resolve a proper harness-assigned name/ref — replace
  this line with the real one the moment a session with that tool picks the
  plan up)

## Context / why

The developer wants every Chrono tenant's public site
(`{tenant}.CHRONO_DOMAIN/`, e.g. `isurina.chrono2.izur.com.ph`) rebuilt so it
reads as **that gaming business's own branded website, powered by Chrono** —
not a Chrono marketing page and not a generic SaaS landing page — and so it
actively converts an anonymous visitor into a signed-up player. This is the
customer-facing, single-tenant half of Chrono's two-sided story.

**Explicit boundary against the sibling plan.** This is a **separate, sibling
plan** to `.ai/plans/chrono/ready/two-sided-growth-loop/README.md` (same day,
different session). That plan owns the **global** Chrono apex
(`CHRONO_DOMAIN`, no tenant) — the two-sided marketing homepage, `/discover`
(cross-tenant business search + cold-start "invite this café" lead capture),
and the apex analytics/nav repositioning. This plan owns the **opposite**
side: the page a player lands on once they already know which business
they're looking at, whether they arrived via a shared link, a search engine,
or the sibling plan's own `/discover` result cards (which already link to a
matched business's tenant-host landing page — see that plan's Phase 3, item
3). This plan does not touch `/discover`, does not add a business directory,
and does not touch the apex `(saas-landing)/page.tsx`'s `!tenant` branch. The
sibling plan's `/discover` is treated here purely as an external dependency —
an upstream source of traffic this plan's pages must convert well, nothing
more.

**This plan was written after four parallel research passes across the
actual codebase** (not memory, not the brief's assumptions) — the single most
important discovery is that **most of the brief's asked-for structure already
exists**, built by the already-archived `.ai/plans/chrono/archive/
tenant-landing/README.md` plan. Chrono already has a foundation-owned,
registry-driven tenant landing mechanism (`CHRONO_LANDING_SECTIONS`,
`apps/chrono-web/src/components/landing/registry.ts`) rendering at **both**
the tenant-host root `/` (`(saas-landing)/page.tsx`'s `tenant` branch, lines
719-759) and `/about` (`(saas-landing)/about/page.tsx`, a near-duplicate) —
11 sections already registered: `hero`, `stations` (**this already is** the
brief's "Live Availability" section — free/in-session/maintenance counts,
already real, already live), `rates`, `specs`, `games`, `about`,
`testimonials` (off by default), `events` (off by default), `contact`,
`faq` (off by default), `cta`. Adding a new section is **one registry entry**
— no page file changes, and it **automatically** appears in the existing
dashboard settings editor's section toggle list (`TENANT_SECTION_CHOICES`,
registry.ts:217-219) with zero additional UI work. This drastically narrows
what this plan actually needs to build, exactly the same shape of narrowing
the sibling plan found for player/partner signup.

So this plan is **not** "build a tenant homepage from scratch." It is: (1)
replace two sections' currently-fabricated content with real tenant data now
that the real schema exists to back it (`rates`, and a new `experience`
section derived from real station data); (2) add the two sections that
genuinely don't exist anywhere yet (a player join/sign-in CTA, and a share
mechanism); (3) fix a handful of concrete, already-identified bugs/gaps
(the tenant-host root `/` silently falls back to the **apex marketing page**
instead of 404ing on an unresolvable subdomain, unlike its own `/about`
sibling; the root page and `/about` emit no Open Graph tags and the root page
emits no metadata at all; `/stations` has zero tenant branding and fabricates
an "In Use" station count that doesn't exist in the data model); and (4)
rebrand `/stations` and wire in the brief's share/analytics/footer-partner-
link asks. Full research findings (verbatim, with file:line citations) were
gathered via four parallel sub-agent passes plus direct reads in this
planning session's transcript; the load-bearing facts are folded into Pass 2
and each phase below.

## Pass 1 — Workflow analysis

- **Who uses this:**
  - An anonymous visitor landing on `{tenant}.CHRONO_DOMAIN/` (or `/about`,
    or `/stations`) from a shared link, a search result, or the sibling
    plan's `/discover` — deciding in seconds "what is this place, is there a
    free PC right now, how do I join."
  - A visitor already signed in as a Chrono global customer
    (`agora/customer-auth`, cookie `agora_customer`) who has never joined
    *this* tenant — the brief's "Join [BUSINESS NAME]" moment.
  - A returning player who is already a member of this tenant (either via the
    tenant-scoped `tenantMember` pool or the global-customer apply-flow) —
    the "Already a member? Sign in" moment.
  - A tenant owner/admin, indirectly, as the beneficiary of the whole
    feature (a branded site + player pipeline) — this plan adds **no new
    admin/dashboard UI**; every new section is picked up automatically by
    the existing settings editor per the registry mechanism above.
- **Workflow enabled:** discover → see live availability + real rates/
  experience → join or sign in → (existing member/customer auth, unchanged)
  → return later → share with friends.
- **Failure cases:**
  - **Unresolvable subdomain** (typo, deleted tenant, never existed): today
    the root `/` **silently renders the generic apex Chrono marketing page**
    at that subdomain URL (`fetchTenant()` returns `null` on a fetch failure
    exactly the same way it does for a true apex host — see Pass 2,
    "Confirmed bug"). `/about` correctly 404s the same case
    (`(saas-landing)/about/page.tsx:43`, `notFound()`). This is not a
    cross-tenant data leak (no other tenant's data is shown), but it is
    confusing and inconsistent with `/about`, and it directly contradicts
    the brief's own explicit "unknown tenant" test scenario. Phase 3 fixes
    this to match `/about`'s behavior.
  - **Suspended tenant**: every existing public read this plan touches or
    extends (`/public/stations`, and the new `/public/venue-info`) must
    reject terminal tenant statuses (`suspended`/`cancelled`/`archived`/
    `deleting`) exactly like `/public/stations` and `/public/branding`
    already do, per `apps/chrono-api/AGENTS.md`'s "Unauthenticated routes"
    convention. Verified for `/public/stations`
    (`apps/chrono-api/src/modules/station/routes.ts:296-304`); the new
    Phase 1 route must be built the same way, not assumed safe by
    resemblance.
  - **Player has no active session and the tenant has zero station data
    yet**: must never dead-end. The join/sign-in CTA (Phase 2) and the
    graceful empty state on `/stations` (unchanged, already exists —
    `client.tsx:82-84`, `"No stations available."`) both already satisfy
    this; Phase 2 must not regress it.
  - **Cross-tenant leakage**: the one genuinely new backend read this plan
    adds (Phase 1, `/public/venue-info`) must never return tenant B's branch/
    rate data when queried against tenant A's host. This is the mandatory
    e2e case (Phase 8). Unlike the sibling plan's cross-tenant `/discover`
    read, every route in this plan (existing and new) resolves **exactly
    one** tenant from the host and reads through `withTenant` (RLS-enforced)
    — never `withAdmin` — so `rls:proof` itself gives defense-in-depth here,
    not just the e2e spec.
- **Audit/notifications:** none of this plan's changes are session-scoped
  tenant *mutations* — every new/changed surface is either a public read or
  presentation-layer JSX. No `recordStaffAudit`/`recordAudit` call applies
  anywhere in this plan (mirrors the sibling plan's own landing-page-adjacent
  precedent).

## Pass 2 — Technical plan

**Boundary:** `apps/chrono-web` (landing registry/sections, `/stations`,
metadata, share, analytics, footer) + a small, read-only addition to
`apps/chrono-api` (one new public route reading two already-existing tables).
**No schema/migration, no new table, no change to `packages/agora`.**

**Nearest existing patterns reused:**
- Landing section registry: `apps/chrono-web/src/components/landing/
  registry.ts` + `apps/chrono-web/AGENTS.md`'s own "Adding a section"
  recipe — copied verbatim for the two new sections.
- Public route pattern: `publicStationRoutes()`
  (`apps/chrono-api/src/modules/station/routes.ts:276-370`) — the exact
  shape (`resolveOrgFromRequest`, `createRateLimiter`/`clientIp` from
  `agora/server`, `withTenant` read, terminal-status rejection, no raw-row
  leakage) the new Phase 1 route mirrors.
- Live-data-through-context pattern: `getTenantStations()`
  (`apps/chrono-web/src/lib/stations.ts`) — `cache()`-wrapped, re-validates
  the response against the imported Zod contract rather than trusting it,
  returns `null` on any failure so a data outage never takes the page down.
  The new `getTenantVenueInfo()` (Phase 1/2) copies this exactly.
- Tenant-branded chrome: `TenantHeader`/`TenantFooter`
  (`apps/chrono-web/src/components/landing/marketing-chrome.tsx`) — reused
  as-is on `/stations` (Phase 4) instead of inventing a second header.
- Rate-limit precedent: `publicStationsLimiter = createRateLimiter(20, 60 *
  1000, "public-stations")` (`station/routes.ts:268`).
- e2e conventions: `apps/chrono-web/e2e/tests/public-stations/
  availability.spec.ts` (154 lines, read in full) — absolute host navigation
  (`http://${slug}.localtest.me:3000`), `faker` from `../../utils/faker`,
  one `test.describe` wrapping a long happy-path-plus-isolation `test`,
  `playwright.config.ts` has no `webServer` (needs `pnpm dev` running first,
  `headless:false`, `slowMo:350`).

**Confirmed bug (Phase 3):** `(saas-landing)/page.tsx`'s `fetchTenant()`
(lines 78-94) calls `getRequestTenant()`; only `t.kind === "apex"` short-
circuits to `null` immediately (line 80). A **subdomain host with no
matching organization row** also ends up at `null` — via the `/public/tenant`
fetch simply returning non-OK (line 89) — and the page falls through to the
exact same generic apex-marketing branch (line ~102 onward) as a true apex
visit. `/about` does not have this problem: it calls `getTenantLanding()`
and explicitly `notFound()`s when it returns `null`
(`about/page.tsx:41-43`). Phase 3 makes the root page match `/about`'s
behavior for a subdomain host specifically, while still falling through to
apex marketing for an actual apex host — these are two different `null`
causes today and must be told apart, not collapsed into one fix that breaks
the real apex fallback.

**Confirmed gap — the "Join" CTA has nowhere real to point today.** The
brief's "Join [BUSINESS NAME]" / "Already a member? Sign in" pair assumes a
signup path is one click away from the landing page. Today: `/login` (a
tenant host) renders `MemberLoginForm`, a **real, working** tenant-scoped
sign-in — but every landing-page CTA that touches auth points only there
(`TenantCta`'s "Member sign in", `TenantHeader`'s "Member login" pill,
`TenantFooter`'s "Sign in") — **none point to a sign-up**. A tenant-scoped
self-service **sign-up** route does exist —
`{slug}.CHRONO_DOMAIN/portal/sign-up` →
`apps/chrono-web/src/app/(member-portal)/portal/sign-up/tenant-sign-up-form.tsx`
(`memberAuth.signUp()`, lands at `/member`) — `MemberLoginForm` itself links
to it ("No account? Create one" → `/portal/sign-up`,
`member-login-form.tsx:109-114`) but the **landing page never surfaces it
directly**. Separately, `ApplyForTenantPrompt`
(`apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx`) — the
global-customer "Join this business" / "Apply" one-click flow the developer
flagged as the likely mechanism — is real and working, but its **only**
importer is `MemberGate` (`apps/chrono-web/src/components/member/
member-gate.tsx:9,123`), whose only importer is `/member`'s own layout
(`(member-area)/member/layout.tsx:3,31`). **A signed-in global customer
viewing a tenant's public site has zero UI path to it** — they would have to
already know to type `/member` into the URL bar. Phase 2 fixes the first gap
(a real, static "Join {tenant}" CTA → `/portal/sign-up`); Phase 6 attempts
the richer session-aware surfacing of the second, with an explicit fallback
if it proves too heavy for a first pass (see Assumption 6).

### Assumptions & explicit scope decisions (flag for developer review before/at implementation)

1. **`rates`/`experience` are wired to real data by extending `ChronoLandingData`
   with a NEW, purpose-built public read — not by overloading `/public/
   stations`.** `ChronoStationGroups.hourlyRate`/`memberRate`
   (`apps/chrono-api/src/modules/station/schema.ts:21-22`, "Flat baseline
   rate — NOT the full oikos `PricingRule` engine") is real, tenant-set data,
   but isn't in the public stations payload today. Rather than change
   `/public/stations` (a focused, already-audited, already-cached route the
   brief explicitly says must not break), this plan adds one new small route,
   `GET /public/venue-info`, following the repo's own established convention
   of one small single-purpose public route per concern (`/public/tenant`,
   `/public/branding`, `/public/stations`, `/public/landing-page` are all
   already separate). It returns the tenant's **first active branch** (by
   `createdAt` ascending — see assumption 2) contact/social/maps fields
   (already public-safe, tenant-authored marketing info) plus that branch's
   station groups' `hourlyRate`/`memberRate`.
2. **Multi-branch venues show only their first branch's contact/rate info on
   the public site, MVP.** Mirrors the sibling plan's own precedent for the
   same limitation (its assumption 8). `TenantContact`'s existing `r.contact`
   block is a single free-text block already, not per-branch, so this isn't
   a new limitation this plan introduces — it's the existing model's shape,
   now also applied to the new rates/social-links data. A per-branch public
   page is real future work, not attempted here.
3. **`specs` and `games` sections are flipped to `defaultEnabled: false`,
   not rebuilt.** Both currently render **hardcoded, non-tenant-specific**
   content today (`DEFAULTS.specs` — "Ryzen 7 class CPU", "RTX-class
   graphics" — and `DEFAULTS.games` — a fixed 8-title list — registry.ts:62-
   83), which is exactly what the brief's "DO NOT CLAIM UNSUPPORTED
   FEATURES" / "Only display items actually configured for the tenant"
   sections forbid. `registry.ts`'s own comment (lines 56-60) already
   documents the real fix (extend `landingConfigSchema` with a tenant-
   editable `venue` block) as a deliberately deferred TODO from the archived
   `tenant-landing` plan — that's a genuine schema/contract change (new
   config fields + editor UI for a tenant to actually type in their specs/
   game list), out of proportion to this plan's scope. The pragmatic,
   honest fix available now is the same one `testimonials`/`events` already
   use for the identical reason (registry.ts:166-168, 177): default the
   section off rather than ship fabricated content. This is a real,
   defensible, one-line-per-section fix, not a shrug — flagged clearly so
   the developer can instead choose to keep them on (accepting the
   fabrication) or fund the bigger `venue` config extension as separate
   follow-up work.
4. **New `experience` section is 100% derived from data already fetched —
   zero new API calls.** `/public/stations`' response already includes
   `stationType` per station (free-text, e.g. `"pc"`/`"vip"`/`"console"` —
   `station/schema.ts:48-50`, confirmed present in the public payload's
   `branches[].stations[]` shape). Phase 2 computes the tenant's **distinct**
   real station types from `getTenantStations()`'s already-fetched result and
   renders them as labeled chips (a small lookup table maps known raw values
   to friendly labels — e.g. `pc` → "Gaming PCs", `vip` → "VIP Gaming PCs" —
   falling back to a title-cased raw value for anything else a tenant sets).
   This satisfies the brief's "Gaming Experience... only display items
   actually configured for the tenant" with genuinely real, per-tenant data
   and no schema change.
5. **"Amenities" (food/drinks, private rooms) and a hero image are explicitly
   NOT built — no schema field exists for either.** `ChronoBranches` has no
   amenities column; `tenantBranding`
   (`packages/agora/src/core/db/schema/tenant.ts:67-96`) has no hero-image
   column, and `ResolvedLandingConfig.hero` has no image field either. Both
   would need a genuine schema/contract addition (plus, for a hero image, a
   storage/upload flow per `.ai/rules/providers.md`) — a real feature, but
   bigger than a presentation-layer plan should absorb unasked. Flagged, not
   silently dropped.
6. **The `promo`/`voucher`/`loyalty` modules exist with real schema
   (`apps/chrono-api/src/modules/{promo,voucher,loyalty}/schema.ts`) —
   contradicting `apps/chrono-api/AGENTS.md`'s stale "Deferred" note for
   them (worth flagging to the developer as doc drift, separately from this
   plan) — but this plan does NOT surface active promos/vouchers on the
   public site.** `ChronoPromos` (discount/minSpend/date-window/max-
   redemptions) looks safely public-shapeable in principle, but confirming
   the exact safe DTO (no unintended internal fields) needs a fresh full
   read of `promo/schema.ts` + `promo/routes.ts` this research pass didn't
   do, and `ChronoVouchers` are explicitly code-based — advertising voucher
   codes publicly would defeat their controlled-distribution purpose. The
   brief's core ask ("how much does it cost to play here?") is already
   honestly answered by real `hourlyRate`/`memberRate` (assumption 1) without
   this. Promo surfacing is real, plausible future work, not attempted here.
7. **Reservations stay member-portal-only, not surfaced publicly.**
   `ChronoReservations`' only reachable-without-a-session-check is none —
   staff CRUD is `tenantMiddleware()`-gated, member self-service is
   `memberMiddleware()`-gated inside `reservation/portal-routes.ts` itself
   (comment: "NEVER tenantMiddleware()"). The only genuinely anonymous
   "check availability" signal is aggregate station status
   (`/public/stations`, unchanged). This plan does not add a public
   reservation-slot read.
8. **The join/sign-in CTA is built in two tiers, not one, and the richer
   tier is allowed to fall back.** Phase 2 ships a static "Join {tenant}" →
   `/portal/sign-up` + "Already a member? Sign in" → `/login` CTA — zero
   session-detection risk, directly satisfies the brief's core copy ask, and
   is fully reviewable on its own. Phase 6 attempts the richer, session-aware
   version (surfacing `ApplyForTenantPrompt` for a signed-in global customer
   who isn't yet this tenant's member) by reusing `MemberGate`'s own
   session-resolution calls (`apps/chrono-web/src/components/member/
   member-gate.tsx` — not yet read in full this research pass, flagged as
   Phase 6's execution start point). If that turns out to need a heavier
   client-side session bootstrap than a marketing page's first paint should
   carry, Phase 6's own acceptance criteria allow shipping nothing further
   and leaving Phase 2's static CTA as the shipped behavior — a graceful,
   explicit de-scope, not a silent gap.
9. **Analytics stays an app-local abstraction, matching the sibling plan's
   design, defined independently if that plan's `apps/chrono-web/src/lib/
   analytics.ts` hasn't landed yet.** Confirmed on disk right now: it does
   not exist (`ls apps/chrono-web/src/lib/` — no `analytics.ts`; zero
   `posthog`/`segment`/`gtag`/`amplitude`/`mixpanel`/`trackEvent` hits
   anywhere in the repo). Phase 7 checks for it first and reuses it if the
   sibling plan has since shipped it; otherwise defines the same minimal
   `track(event, props)` shape (dev-only `console.log`, no-op otherwise)
   independently — a few lines, not a second design, so neither plan blocks
   on the other. Event names are the brief's own eight, verbatim (it names
   them explicitly, unlike the sibling plan which invented its own seven):
   `TENANT_PAGE_VIEW`, `TENANT_STATIONS_VIEW`, `PLAYER_SIGNUP_FROM_TENANT`,
   `PLAYER_LOGIN_FROM_TENANT`, `TENANT_SHARE`, `DIRECTIONS_CLICK`,
   `CONTACT_CLICK`, `STATION_AVAILABILITY_INTERACTION`.
10. **Share is Web Share API + a manual copy-link fallback, nothing platform-
    specific.** Confirmed zero precedent for `navigator.share`, any
    "react-share"-style library, or a `ShareButton` component anywhere in the
    repo — the brief's own "do not build platform-specific integrations
    unless already supported" is satisfied by construction, not by choice.
11. **The live-availability station-status breakdown must use the real
    three-state enum (`available`/`maintenance`/`offline`), never a fourth
    "in use" state.** `ChronoStations.status`
    (`station/schema.ts:51-54`) supports only those three values today —
    `"occupied"` is explicitly reserved for later, once sessions exist
    (`apps/chrono-api/AGENTS.md`: "`session` — contracts + money helpers in
    progress; no schema/routes yet"). The current public-stations response's
    `aggregate.inUse` field is actually computed as `maintenance + offline`
    combined (`station/routes.ts:333`, comment: "Will be refined when
    sessions exist") — it does **not** mean "currently being played." Phase
    4's `/stations` rebrand must present real labels (Available / Maintenance
    / Offline) and must not invent an "In Use" count session tracking can't
    back yet, even though the brief's own example copy uses that phrase.
12. **The footer's second attribution line ("Run your gaming business with
    Chrono →") links to the apex via the existing `NEXT_PUBLIC_APP_DOMAIN`
    env var precedent** (`apps/chrono-web/src/lib/post-auth.ts:22`,
    `` `${window.location.protocol}//${first.slug}.${APP_DOMAIN}` `` is the
    existing pattern for building a cross-host URL from a tenant page — this
    plan's link omits the `{slug}.` prefix to land on the bare apex). The
    existing "Powered by Chrono" line (`TenantFooter`,
    `marketing-chrome.tsx:401-407`, default-visible, no tenant opt-out
    surfaced) is left exactly as-is — the brief wants it to stay, not become
    tenant-toggleable.

## CRUD & Feedback Contract

**No new persisted entity.** Every new backend surface in this plan (Phase 1)
is a read-only projection of two tables that already exist
(`ChronoBranches`, `ChronoStationGroups`) — no new table, no migration. The
landing registry's new/changed sections (`experience`, `playerCta`, `share`,
plus the `rates`/`specs`/`games` changes) are **registry config (code)**,
exactly like every other section already in `CHRONO_LANDING_SECTIONS` — not
stored data, so no CRUD matrix applies. **Feedback contract:** the share
action surfaces a `toast.success("Link copied")` on the clipboard-fallback
path (per `.ai/rules/ui.md`'s `sonner` convention) and no toast at all on the
native Web Share path (the OS share sheet is its own confirmation). The
join/sign-in CTAs surface no new feedback of their own — they link to
`/portal/sign-up` and `/login`, whose existing success/error toasts are
unchanged by this plan.

---

## Phase 1 — Backend: `GET /public/venue-info`

**Files to update:**
- `apps/chrono-api/src/modules/branch/contracts.ts` (add
  `publicVenueInfoResponseSchema`)
- `apps/chrono-api/src/modules/branch/routes.ts` (add `publicVenueInfoRoutes()`)
- `apps/chrono-api/src/app.ts` (mount `.route("/public/venue-info",
  publicVenueInfoRoutes())` alongside the existing `/public/stations`,
  `/public/tenant`, `/public/branding` mounts)

**Step-by-step tasks:**
1. Read `apps/chrono-api/src/modules/station/routes.ts`'s
   `publicStationRoutes()` (lines 276-370) in full — this is the exact
   pattern to mirror: `resolveOrgFromRequest(c)` for tenant resolution
   (never a client-supplied id), the terminal-status guard (lines 296-304),
   `createRateLimiter`/`clientIp` from `agora/server`, a `withTenant(tenantId,
   …)` read (RLS-enforced — this route serves exactly one tenant, so
   `withTenant` is correct, not `withAdmin`).
2. Add `publicVenueInfoResponseSchema` to `branch/contracts.ts`:
   `{ branch: { name, address, googleMapsUrl, operatingHours, contactNumber,
   email, socialLinks } | null, rateGroups: Array<{ id, name, hourlyRate,
   memberRate }> }` — all branch fields nullable per the confirmed
   `ChronoBranches` schema (`branch/schema.ts:8-36`, only `id`/`tenantId`/
   `name`/`code`/`status`/`timezone` are non-nullable); `hourlyRate`/
   `memberRate` serialize as strings (Drizzle `numeric` columns), matching
   how the rest of the app already handles money fields.
3. Add `publicVenueInfoRoutes()` to `branch/routes.ts`:
   - `const publicVenueInfoLimiter = createRateLimiter(20, 60 * 1000,
     "public-venue-info")` (same numbers as `publicStationsLimiter`, same
     rationale — a marketing page, not a money-moving route).
   - `resolveOrgFromRequest(c)`, 404 if none; reject terminal statuses
     exactly like `publicStationRoutes()` does.
   - Via `withTenant(org.id, tx => …)`: select the tenant's first branch
     with `status = "active"` ordered by `createdAt` ascending, limit 1
     (assumption 2); if found, cross-module-import `chronoStationGroup` from
     `../station/schema` and select all groups for that branch id.
   - Return `publicVenueInfoResponseSchema`-shaped JSON; `branch: null` +
     `rateGroups: []` (a normal 200, never a 404) when the tenant has no
     active branch yet — matches the existing "never dead-end" convention
     `/public/stations` already follows for zero-station tenants.
4. Mount the route in `app.ts` alongside the other `/public/*` routes
   (confirm the exact current line for `/public/stations`'s own mount before
   editing — `apps/chrono-api/AGENTS.md` cites it near line 1171, re-verify).

**Acceptance criteria:**
- `GET /public/venue-info` on a seeded tenant with one active branch + one
  station group returns real `branch`/`rateGroups` data, never a 404.
- A tenant with no active branch returns `{ branch: null, rateGroups: [] }`,
  200.
- A suspended/cancelled/archived/deleting tenant's host returns 404, same as
  `/public/stations`.
- An unresolvable host returns 404.
- No raw DB row is returned — response matches
  `publicVenueInfoResponseSchema` exactly, no extra columns.
- `pnpm --filter @agora/chrono-api typecheck` passes.
- `pnpm --filter @agora/api rls:proof` still prints `RLS PROOF: PASS ✅`.

**Verification commands:**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/api rls:proof`
- Manual: `pnpm --filter @agora/chrono-api dev`, curl the new route for a
  seeded tenant with data, a seeded tenant with no branch, a suspended
  tenant, and an unknown subdomain — confirm all four behaviors above before
  Phase 8's e2e spec is written.

**Out of scope:**
- Any change to `/public/stations` itself (untouched, per assumption 1).
- Multi-branch public data (assumption 2).
- Active promo/voucher surfacing (assumption 6).

**Execution start point:** `apps/chrono-api/src/modules/station/routes.ts`,
`publicStationRoutes()` (lines 268-370) — read in full before writing the new
route.

---

## Phase 2 — Web: landing registry rewire (rates, experience, business info, player CTA)

**Files to update:**
- `apps/chrono-web/src/lib/venue.ts` (new — mirrors `stations.ts` exactly)
- `apps/chrono-web/src/components/landing/registry.ts`
- `apps/chrono-web/src/components/landing/tenant-sections.tsx`
- `apps/chrono-web/src/app/(saas-landing)/page.tsx` (tenant branch: fetch +
  pass the new data into context)
- `apps/chrono-web/src/app/(saas-landing)/about/page.tsx` (same)

**Step-by-step tasks:**
1. Read `apps/chrono-web/src/lib/stations.ts` in full (47 lines) — copy its
   exact shape (`cache()`-wrapped, re-parses against the imported Zod
   contract, `null` on any failure) for the new `getTenantVenueInfo()`,
   consuming Phase 1's `publicVenueInfoResponseSchema`.
2. Extend `ChronoLandingData` (registry.ts:28-33) with `venue?:
   PublicVenueInfoResponse | null`.
3. `rates` section (registry.ts:123-131): change `propsFrom` to read
   `chronoData(ctx).venue?.rateGroups`, mapping each `{name, hourlyRate,
   memberRate}` into `TenantRates`'s existing card shape — replaces
   `DEFAULT_RATES` entirely. If `rateGroups` is empty, render the section's
   existing graceful "no rates configured yet" path if one exists, or hide
   the section for that render (confirm `TenantRates`'s current behavior on
   empty input before deciding which).
4. New `experience` section (registry key `experience`, `defaultOrder: 35`
   — between `specs`=30 and `games`=40, both being disabled this phase):
   - New `TenantExperience` component in `tenant-sections.tsx`: a chip row
     of the tenant's distinct real `stationType` values (derived from
     `chronoData(ctx).stations?.branches` — already fetched, no new API
     call, per assumption 4), via a small `STATION_TYPE_LABELS` lookup
     (`pc` → "Gaming PCs", `vip` → "VIP Gaming PCs", `console` → "Console
     Gaming" — exact copy finalized at implementation time) falling back to
     a title-cased raw value. Renders `null` if the tenant has zero
     stations yet (never an empty chip row).
5. `specs`/`games` (registry.ts:132-149): flip both to `defaultEnabled:
   false`, same one-line change already used for `testimonials`/`events`
   and the same cited reason (assumption 3) — add a comment citing this
   plan.
6. `about`/`contact` enhancement: extend `TenantContact` to also render
   `chronoData(ctx).venue?.branch?.socialLinks` (Facebook/Messenger/
   Instagram/TikTok/Discord icon links, whichever are non-null) — this data
   exists on `ChronoBranches` today (`socialLinks` jsonb,
   `branch/schema.ts:23-29`) and is not rendered anywhere yet.
7. New `playerCta` section (registry key `playerCta`, `defaultOrder: 18` —
   between `stations`=15 and `rates`=20, right after live availability per
   the brief's own hierarchy): new `TenantPlayerCta` component — headline
   "Stay connected to {tenant}.", primary CTA "Join {tenant}" →
   `/portal/sign-up`, secondary "Already a member? Sign in" → `/login`. Pure
   server-rendered links, no session check (assumption 8, tier 1).
8. Enhance the existing closing `cta` section (registry.ts:202-213,
   `TenantCta`): add a "Get Directions" secondary CTA using
   `chronoData(ctx).venue?.branch?.googleMapsUrl` when present (satisfies
   the brief's "Location / Visit CTA" section — "Ready to play? / Check
   Availability / Get Directions").
9. Wire `getTenantVenueInfo()` into both `page.tsx` (tenant branch) and
   `about/page.tsx`'s existing `Promise.all([getTenantLanding(),
   getTenantStations()])` calls (add the new fetch alongside them, same
   parallel-fetch shape) and pass the result into
   `LandingSections`'s `context.data`.

**Acceptance criteria:**
- A seeded tenant with real `ChronoStationGroups` rates shows those exact
  numbers on `/` and `/about` — never `DEFAULT_RATES`' hardcoded values.
- A seeded tenant with stations of two distinct `stationType` values shows
  exactly those two experience chips — no invented categories.
- `specs`/`games` no longer render for a tenant that hasn't explicitly
  re-enabled them via the existing settings editor (they still exist as
  togglable choices in `TENANT_SECTION_CHOICES` — a tenant CAN turn them
  back on if they accept the placeholder content, per the settings editor's
  existing generic toggle mechanism).
- Social links render when `ChronoBranches.socialLinks` has at least one
  non-null field; render nothing extra when it's null.
- "Join {tenant}" links to `/portal/sign-up`; "Already a member? Sign in"
  links to `/login`; both real, working, unauthenticated-reachable routes.
- "Get Directions" appears only when the tenant's first branch has a
  `googleMapsUrl`.
- Every new/changed section composes only from `agora/ui` primitives
  (`.ai/rules/component-first-ui.md`) — no raw `div`/`span` chrome beyond
  what `tenant-sections.tsx` already establishes as its own convention.
- Works at 375px/640px/1024px+, both themes, per the brief's mobile-priority
  section.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: both dev servers running, visit a seeded tenant's `/` and
  `/about`, confirm every acceptance criterion above at the three widths,
  both themes, and toggle `specs`/`games`/`experience`/`playerCta` on/off in
  the existing settings editor to confirm they behave like every other
  registry section.

**Out of scope:**
- The session-aware `ApplyForTenantPrompt` surfacing (Phase 6).
- Any settings-editor UI change — the existing generic toggle list already
  covers the new sections (per Context).
- Active promo/voucher content (assumption 6).

**Execution start point:** `apps/chrono-web/src/components/landing/
registry.ts` in full, then `apps/chrono-web/src/lib/stations.ts` in full.

---

## Phase 3 — Web: root `/` unresolvable-tenant fix + SEO/OpenGraph metadata

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx`
- `apps/chrono-web/src/app/(saas-landing)/about/page.tsx`

**Step-by-step tasks:**
1. Re-read `fetchTenant()` (page.tsx:78-94) and the branch split (line ~96
   onward) in full — confirm current line numbers before editing (this file
   has moved across multiple prior plans).
2. Distinguish the two `null` causes: `getRequestTenant()`'s `kind` field
   already tells apex (`"apex"`) apart from a resolved-but-unmatched
   subdomain (`kind !== "apex"` but the `/public/tenant` fetch 404s). Change
   the tenant branch's entry so that a subdomain `kind` with a failed
   tenant fetch calls `notFound()` (matching `/about`'s existing behavior,
   `about/page.tsx:41-43`), while a true apex `kind` still falls through to
   the existing generic marketing branch unchanged.
3. Add `export async function generateMetadata()` to the tenant branch of
   `page.tsx` (it has none today — confirmed by reading the full file) —
   mirror `about/page.tsx:24-33` exactly (`resolved.seo.title ?? venueName`,
   `resolved.seo.description ?? resolved.hero.subtitle`), plus add
   `openGraph: { title, description, images: branding?.logoUrl ? [{ url:
   branding.logoUrl }] : undefined, url: <tenant's own canonical URL>, type:
   "website" }` to **both** `page.tsx`'s new export and `about/page.tsx`'s
   existing one — neither currently emits Open Graph tags at all (confirmed:
   only `title`/`description` are returned today). No dedicated hero/OG
   image exists (assumption 5) — the tenant's own `logoUrl` is the only real
   image available; omit `images` entirely when there is no logo, never
   fabricate a placeholder image URL.
4. Do not touch the apex (`!tenant`) branch of either file.

**Acceptance criteria:**
- Visiting a nonsense, never-registered subdomain at `/` returns 404 (same
  as `/about` already does), not the generic Chrono marketing page.
- Visiting the true apex host at `/` still renders the generic marketing
  page unchanged.
- `curl`/view-source on a seeded tenant's `/` and `/about` show a tenant-
  specific `<title>`, `<meta name="description">`, and `og:title`/
  `og:description`/`og:url` (plus `og:image` when a logo exists) — never the
  root layout's generic fallback title.
- `pnpm --filter @agora/chrono-web typecheck` passes; `pnpm --filter
  @agora/chrono-web build` succeeds.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual: visit a nonsense subdomain, the true apex host, and a real seeded
  tenant's `/`/`/about`; `curl -s <url> | grep -i 'og:\|<title\|description'`
  for the metadata check.

**Out of scope:** any change to the apex marketing branch's own metadata
(already Chrono-branded per the archived `saas-landing-rebuild` plan).

**Execution start point:** `apps/chrono-web/src/app/(saas-landing)/page.tsx`
lines 78-102 and `about/page.tsx` lines 24-46 — read both fully first.

---

## Phase 4 — Web: `/stations` tenant-branded rebuild

**Files to update:**
- `apps/chrono-web/src/app/(tenant-landing)/stations/page.tsx`
- `apps/chrono-web/src/app/(tenant-landing)/stations/client.tsx`

**Step-by-step tasks:**
1. Read both files in full (51 + 142 lines) — confirmed current copy:
   `"Station Availability"` / `"Live view of available stations"`
   (`page.tsx:42-43`), no tenant branding, no return-home link, no player
   CTA anywhere in `client.tsx`.
2. `page.tsx`: fetch `getPublicBranding()` alongside the existing station
   fetch; replace the generic `<h1>`/`<p>` with `TenantHeader` (reused as-is
   from `marketing-chrome.tsx`, same component the landing pages already
   use — no bespoke second header) showing the tenant's logo/name, plus a
   headline `"{tenant name} — Live PC Availability"` and subheading
   naming what the counts mean. Add `generateMetadata()` (none exists
   today) with tenant-specific title/description, same pattern as Phase 3.
3. `client.tsx`: replace the hardcoded Tailwind color classes
   (`bg-green-500`, `text-orange-600 dark:text-orange-500`, etc. — lines
   69, 77, 99-106, 114-119) with semantic tokens, per `.ai/rules/
   styling.md`/`.ai/rules/component-first-ui.md` (both violated today —
   this is a real, pre-existing gap the brief's "component-first" and "no
   ad-hoc color" rules already require fixing whenever this file is next
   touched, and this phase touches it). Rename the summary card and status
   labels to the real three-state enum (assumption 11): "Available" /
   "Maintenance" / "Offline" — **not** "In Use" (no such tracked state
   exists). Add a "Back to {tenant}" link to the tenant's own `/` and, when
   the tenant has zero station data, keep the existing graceful empty state
   (`"No stations available."`, `client.tsx:82-84`) but surface the
   `playerCta` section's same "Join {tenant}" CTA below it so this page
   never dead-ends either.
4. Confirm `TenantFooter` is reused at the bottom of this page too (not
   present today) for consistent branding/attribution across every public
   tenant surface.

**Acceptance criteria:**
- `/stations` shows the tenant's logo/name via the same `TenantHeader` used
  elsewhere — no bespoke header markup.
- Status labels read Available/Maintenance/Offline everywhere on this page
  — no "In Use" anywhere.
- No hardcoded Tailwind color class remains in `client.tsx` — semantic
  tokens only.
- A "Back to {tenant}" link and a "Join {tenant}" CTA both exist and work.
- Suspended/unknown-tenant/no-station-data behavior is unchanged from
  today (still 404s / still shows the graceful empty state) — this phase
  changes presentation only, not the existing tenant-resolution or
  terminal-status logic in `page.tsx`'s data fetch or the backing
  `publicStationRoutes()`.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: a seeded tenant with mixed available/maintenance/offline
  stations, a tenant with zero stations, a suspended tenant, an unknown
  subdomain — confirm each renders correctly, at 375px/640px/1024px+, both
  themes.

**Out of scope:** any change to `apps/chrono-api/src/modules/station/
routes.ts` or the `/public/stations` response shape itself — presentation
only, per the brief's own "upgrade its presentation" framing and the
Non-Goals in Pass 2.

**Execution start point:** `apps/chrono-web/src/app/(tenant-landing)/
stations/page.tsx` and `client.tsx` — read both in full first.

---

## Phase 5 — Web: share mechanism + footer partner link

**Files to update:**
- `apps/chrono-web/src/components/landing/tenant-sections.tsx` (new
  `TenantShare` component)
- `apps/chrono-web/src/components/landing/registry.ts` (new `share`
  section)
- `apps/chrono-web/src/components/landing/marketing-chrome.tsx`
  (`TenantFooter`: add the partner-link line)

**Step-by-step tasks:**
1. New `share` section (registry key `share`, `defaultOrder: 95` — just
   before the closing `cta`=100, per the brief's late-page placement):
   `TenantShare` renders a single "Share this gaming cafe" button. On
   click: if `navigator.share` exists (feature-detected client-side, no
   platform-specific SDK), call it with `{ title: tenantName, url:
   <tenant's own canonical URL> }`; otherwise fall back to
   `navigator.clipboard.writeText(url)` + `toast.success("Link copied")`
   (per `.ai/rules/ui.md`'s `sonner` convention). No Messenger/Facebook/
   Discord-specific SDK integration — confirmed zero precedent exists
   anywhere in the repo (assumption 10), and the OS-native share sheet
   already reaches those targets on a phone, which is the brief's actual
   ask ("support native Web Share where appropriate and a fallback").
2. `TenantFooter` (`marketing-chrome.tsx:341-411`): add a second line below
   the existing "Powered by Chrono" text — "Run your gaming business with
   Chrono →" — linking to the apex host, constructed via the existing
   `NEXT_PUBLIC_APP_DOMAIN` precedent (`post-auth.ts:22`), per assumption
   12. Leave "Powered by Chrono" and its default-visible behavior
   completely unchanged.

**Acceptance criteria:**
- On a device/browser that supports `navigator.share`, clicking "Share this
  gaming cafe" opens the OS share sheet with the tenant's own name and URL.
- On a browser without it, clicking the button copies the link and shows a
  success toast — no console error, no dead click.
- The footer shows both "Powered by Chrono" (unchanged) and the new "Run
  your gaming business with Chrono →" link, and the link navigates to the
  apex host, not a 404.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: test the share button in a browser with and without
  `navigator.share` (e.g. via devtools feature toggling or a mobile
  browser vs. desktop Chrome), confirm the footer link's destination.

**Out of scope:** any Messenger/Facebook/Discord-specific SDK, deep link,
or share-tracking pixel (assumption 10).

**Execution start point:** `apps/chrono-web/src/components/landing/
marketing-chrome.tsx`, `TenantFooter` (lines 341-411) — read in full first.

---

## Phase 6 — Web: session-aware player-CTA enhancement (best-effort, may de-scope)

**Files to update:**
- `apps/chrono-web/src/components/landing/tenant-sections.tsx`
  (`TenantPlayerCta`, extended)
- Possibly a new small client component, depending on what Phase 6's
  research finds `MemberGate` doing.

**Step-by-step tasks:**
1. Read `apps/chrono-web/src/components/member/member-gate.tsx` in full —
   this research pass did not open it; confirm exactly what session-state
   read(s) it performs to distinguish "anonymous," "signed-in global
   customer, not yet this tenant's member," and "already this tenant's
   member."
2. If those reads are cheap enough to run from a public marketing page's
   first paint (e.g. a single lightweight client-side "who am I" fetch,
   not a heavier bootstrap sequence): extend `TenantPlayerCta` to a small
   client component that, for a signed-in-but-not-yet-member global
   customer, renders `ApplyForTenantPrompt`
   (`apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx`,
   reused as-is, not duplicated) instead of the static "Join" link; for an
   already-member visitor, renders a "Continue to your account" link to
   `/member` instead.
3. If step 1's reads turn out to require a heavier session bootstrap than
   is reasonable for this page: stop here, leave Phase 2's static CTA as
   the shipped behavior, and record that explicitly as this phase's
   outcome — a deliberate, reasoned de-scope per assumption 8, not a
   silent gap.

**Acceptance criteria:**
- Either: a signed-in global customer viewing a tenant they haven't joined
  sees the real `ApplyForTenantPrompt` UI directly on the landing page and
  successfully applies (verified via the same `POST /portal/customer/apply`
  call `ApplyForTenantPrompt` already makes) — **or** — this phase's
  acceptance criterion is explicitly "de-scoped, Phase 2's static CTA
  stands," recorded in this plan's Verification checklist with the reason
  from step 3.
- No regression to the existing `/member`-gated `MemberGate` flow itself —
  this phase only adds a second place the same components can render from.
- `pnpm --filter @agora/chrono-web typecheck` passes (whichever branch is
  taken).

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: sign in as a global customer via `/portal/sign-up` at the apex,
  visit a tenant's landing page you haven't joined, confirm the enhanced
  (or de-scoped) behavior.

**Out of scope:** any change to `MemberGate`, `/member`'s own gate cascade,
or `applyForTenantMembership()` itself — reused, never modified.

**Execution start point:** `apps/chrono-web/src/components/member/
member-gate.tsx` — read in full before deciding which branch of this phase
applies.

---

## Phase 7 — Web: analytics abstraction + instrumentation

**Files to update:**
- `apps/chrono-web/src/lib/analytics.ts` (new, unless the sibling plan's
  own version has already landed — check first)
- Call sites: `TenantPlayerCta`/`ApplyForTenantPrompt` (Phase 2/6), the
  `/stations` page (Phase 4), `TenantShare` (Phase 5), the closing `cta`'s
  "Get Directions" (Phase 2), `TenantContact`'s contact links, the live-
  availability (`stations`) section, `MemberLoginForm`'s successful sign-in,
  `tenant-sign-up-form.tsx`'s successful sign-up.

**Step-by-step tasks:**
1. Check whether `apps/chrono-web/src/lib/analytics.ts` already exists (the
   sibling `two-sided-growth-loop` plan may have shipped it by
   implementation time). If yes, reuse it as-is. If not, define it fresh:
   a closed union type for the brief's eight named events with a typed
   props shape per event, and `track(event, props?)`: `console.log` in dev
   only, no-op otherwise — structured so a future real vendor call is a
   one-function change (assumption 9).
2. Add one `track(...)` call at each of the eight brief-named events:
   `TENANT_PAGE_VIEW` (tenant landing page view), `TENANT_STATIONS_VIEW`
   (`/stations` page view), `PLAYER_SIGNUP_FROM_TENANT` (successful
   `/portal/sign-up` completion from a tenant host, or a successful
   Phase 6 apply), `PLAYER_LOGIN_FROM_TENANT` (successful `MemberLoginForm`
   sign-in), `TENANT_SHARE` (the share button, both native and fallback
   paths), `DIRECTIONS_CLICK` (the "Get Directions" CTA), `CONTACT_CLICK`
   (any phone/email/social link in `TenantContact`), and
   `STATION_AVAILABILITY_INTERACTION` (the live-availability section's
   "View All Stations" CTA).

**Acceptance criteria:**
- All eight events fire at the correct call site, verified via browser
  console during manual testing.
- No `console.log` remains anywhere else added by this plan (per
  `.ai/rules/code-quality.md`) — only inside `analytics.ts`'s own guarded
  dev path.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: open browser console, exercise each of the eight flows, confirm
  one log line per action with the correct props shape.

**Out of scope:** a real analytics vendor integration (assumption 9).

**Execution start point:** `ls apps/chrono-web/src/lib/analytics.ts` first
— confirm whether it already exists before writing a second one.

---

## Phase 8 — E2E specs

**Files to update:**
- `apps/chrono-web/e2e/tests/venue-info/cross-tenant-isolation.spec.ts` (new)
- `apps/chrono-web/e2e/tests/tenant-landing/public-site-happy-path.spec.ts` (new)
- `apps/chrono-web/e2e/tests/tenant-landing/root-unresolvable-tenant.spec.ts` (new)
- `apps/chrono-web/e2e/tests/public-stations/branded-availability.spec.ts` (new)

**Step-by-step tasks:**
1. Read `apps/chrono-web/e2e/tests/public-stations/availability.spec.ts`
   (154 lines) and `apps/chrono-web/e2e/tests/tenant-landing/
   landing-customization.spec.ts` in full first — confirmed conventions:
   absolute host navigation (`http://${slug}.localtest.me:3000`), `faker`
   from `../../utils/faker`, `playwright.config.ts` has no `webServer`
   (`pnpm dev` must already be running), `headless:false`/`slowMo:350`.
2. `cross-tenant-isolation.spec.ts`: seed two tenants, each with its own
   branch + station group rates; assert tenant A's `GET /public/venue-info`
   (queried with tenant A's host header) never returns tenant B's
   branch/rate data, and vice versa. **This is the mandatory tenant-
   isolation proof for Phase 1's new route.**
3. `public-site-happy-path.spec.ts`: visit a seeded tenant's `/`; assert
   the hero, live-availability, `playerCta` (Join/Sign-in links present and
   correct), `experience` chips, real rates, business info (contact +
   social links), share button, and footer (both attribution lines) all
   render; assert `/about` renders the same content.
4. `root-unresolvable-tenant.spec.ts`: visit a nonsense subdomain at `/`,
   assert 404 (Phase 3's regression guard); visit the true apex host,
   assert the generic marketing page still renders (guards against
   Phase 3's fix over-correcting).
5. `branded-availability.spec.ts`: visit a seeded tenant's `/stations`,
   assert tenant branding, real Available/Maintenance/Offline labels (never
   "In Use"), the "Back to {tenant}" link, and the "Join {tenant}" CTA in
   the empty state all render correctly.

**Acceptance criteria:**
- All four specs pass locally per the confirmed runner conventions.
- The cross-tenant-isolation spec genuinely fails if the new route's
  `withTenant`/`resolveOrgFromRequest` scoping is removed (confirm this by
  temporarily breaking it, running the spec, seeing it fail, then
  restoring — the standard "does this test actually test anything" check,
  per `.ai/rules/rbac.md`'s gate-test precedent applied to isolation
  instead of permissions).

**Verification commands:**
- `npx playwright test e2e/tests/venue-info/ e2e/tests/tenant-landing/
  e2e/tests/public-stations/branded-availability.spec.ts` (from
  `apps/chrono-web`, both dev servers already running).

**Out of scope:** re-testing the unchanged `/public/stations` route's own
existing isolation coverage (already proven by `availability.spec.ts`,
untouched by this plan).

**Execution start point:** `apps/chrono-web/e2e/tests/public-stations/
availability.spec.ts` — read in full before writing any new spec.

---

## Phase 9 — Docs + wrap-up

**Files to update:**
- `apps/chrono-api/AGENTS.md` (Landing pages section + Surfaces section)

**Step-by-step tasks:**
1. Read `apps/chrono-api/AGENTS.md`'s "Landing pages" and "Surfaces"
   sections in full first.
2. Document: the new `GET /public/venue-info` route (purpose, rate limit,
   isolation model), the `experience`/`playerCta`/`share` sections added to
   `CHRONO_LANDING_SECTIONS`, the `specs`/`games` default-off change and
   why (assumption 3), and the root-`/`-vs-`/about` 404 parity fix
   (Phase 3).
3. Flag the `promo`/`voucher`/`loyalty` "Deferred" doc-drift finding
   (assumption 6) as a separate one-line correction in the "Modules"
   section's "Deferred" list, distinct from this plan's own feature work —
   confirm with the developer before editing that unrelated line, since
   it's a pre-existing inaccuracy this plan's research incidentally found,
   not something this plan's phases caused.
4. Move this plan from `.ai/plans/chrono/in-progress/tenant-white-label-
   site/` to `.ai/plans/chrono/archive/tenant-white-label-site/` once every
   phase above is verified, per `.ai/rules/feature-planning.md`'s Plan
   Closure step — a separate final commit, not part of this phase's commit.

**Acceptance criteria:**
- `apps/chrono-api/AGENTS.md` accurately reflects every change above.
- Plan moved to `archive/` with all phase checkboxes in the Verification
  section below marked complete.

**Verification commands:** none beyond a final `pnpm typecheck` /
`turbo run build` across the workspace.

**Out of scope:** nothing — this is the closing phase.

**Execution start point:** `apps/chrono-api/AGENTS.md`'s "Landing pages"
section.

---

## Out of scope (whole plan)

- `/discover`, the cross-tenant business directory, and the apex marketing
  homepage's own repositioning — all owned by the sibling
  `two-sided-growth-loop` plan.
- The `landingConfigSchema` `venue` block extension that would make
  `specs`/`games` genuinely tenant-editable (assumption 3) — flagged as
  real, deferred follow-up work, not attempted here.
- Active promo/voucher public surfacing (assumption 6).
- Public reservation-slot data (assumption 7).
- A hero image field/upload flow, and any "amenities" (food/drinks, private
  rooms) beyond real station-type categories (assumption 5) — no schema
  field exists for either.
- Multi-branch public business-info/rates display (assumption 2) — first
  active branch only.
- Any Messenger/Facebook/Discord-specific share SDK integration
  (assumption 10).
- A real analytics vendor integration (assumption 9).
- Any change to `/public/stations`'s response shape or the underlying
  `publicStationRoutes()` query logic — Phase 4 changes only that route's
  web-side presentation.
- Any change to `MemberGate`, `applyForTenantMembership()`, or the
  `/member` gate cascade itself (Phase 6 only adds a second render site for
  the same existing components, best-effort).
- Promoting anything in this plan to `packages/agora` — everything here is
  Chrono-specific presentation and one Chrono-specific read.

## Verification (overall — check off during implementation, not now)

- [ ] Phase 1: `rls:proof` passes; new route rejects suspended/unknown
      tenants; no raw row leakage; manual curl checks pass.
- [ ] Phase 2: real rates/experience/social-links/directions render for a
      seeded tenant; `specs`/`games` off by default but still togglable;
      Join/Sign-in CTAs work; verified at three widths, both themes.
- [ ] Phase 3: unresolvable subdomain 404s at `/`; true apex still falls
      through correctly; OG tags present on `/` and `/about` for a seeded
      tenant.
- [ ] Phase 4: `/stations` shows tenant branding, real status labels (no
      "In Use"), no hardcoded color classes remain, verified at three
      widths, both themes, across available/empty/suspended/unknown states.
- [ ] Phase 5: share button works (native + fallback paths); footer shows
      both attribution lines with correct destinations.
- [ ] Phase 6: either the session-aware enhancement works end-to-end, or
      this phase's explicit de-scope is recorded here with its reason.
- [ ] Phase 7: all eight analytics events verified firing; no stray
      `console.log`.
- [ ] Phase 8: all four e2e specs pass, including the cross-tenant-
      isolation spec's fail-when-broken check.
- [ ] Phase 9: `apps/chrono-api/AGENTS.md` updated; plan archived.
- [ ] `pnpm typecheck` (workspace-wide) passes.
- [ ] `pnpm --filter @agora/api rls:proof` passes.
- [ ] `turbo run build` passes.
