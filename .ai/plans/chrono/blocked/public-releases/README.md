# Chrono — `public-releases` module (BLOCKED)

**Status: BLOCKED, not active.** This plan requires `app-versions` (the registry of
published Chrono PC-client desktop builds) to exist first. As of this writing,
`.ai/plans/chrono/blocked/app-versions/README.md` has landed concurrently (written by
another session during this same planning pass) — but it is itself filed under
`blocked/`, not `active/`, and per its own opening line is blocked on "no PC-client app
exists in this workspace... and no device-pairing/bearer-auth mechanism has landed yet."
No schema, migration, or route for it exists in `apps/chrono-api/src/modules/` — a plan
existing is not the same as the dependency being implemented. Per this task's
instructions, this plan is written in full through Pass 1/Pass 2 (useful groundwork —
the design questions below don't change once `app-versions` lands), but every
implementation phase is explicitly blocked pending that dependency, and the file lives
under `blocked/`, not `active/`, until `app-versions` is unblocked, planned-and-active,
and at least its schema phase is implemented. Read that plan's own Pass 1/Pass 2 before
resuming this one — it independently confirms the platform-global (not tenant-scoped)
design this plan's Divergence #1 also argues for.

`app-versions` and `public-releases` are themselves out of scope to plan here — an
`app-versions` plan is a separate, prerequisite piece of work the developer would need
to commission first (see "Unblocking" at the end of this file).

## What this is

A public changelog/release-notes page for Chrono's PC-client desktop app (the kiosk
software that runs on a station's physical PC) — "what's new in the latest client,"
plus a download link for the current installer. Distinct from `public-stations` (plan
#1): this page is not tenant-specific — the PC client is one product distributed to
every tenant's stations, not a per-venue artifact.

## Pass 1 — Workflow Analysis

- **Who uses this**: two audiences, both effectively public/unauthenticated —
  (a) end customers or venue owners curious what's changed, (b) IT staff at a venue who
  need to download the current installer for a new kiosk PC. Neither needs a tenant
  session; this is a **platform-global** page (e.g. `CHRONO_DOMAIN/download` or
  `/releases` on the apex, not a `{tenantSlug}.` host), unlike plans #1 and #3.
- **Workflow**: visitor hits the page → sees a list of published versions (version
  number, release date, release notes, mandatory-update flag) newest first → clicks a
  download link for the current stable build.
- **Failure cases**: no published version yet → empty state, not an error. A malformed/
  missing installer URL on a version row → hide the download button for that row rather
  than link to a 404 binary. No tenant-isolation concern at all here — there is no
  tenant dimension to this data (see "Divergence" below, item 1), which is itself the
  key design decision this plan makes explicit.
- **Audit/notifications**: none for the public read. Registering/promoting/archiving an
  app version (an internal, not-yet-designed admin action) would warrant audit linkage,
  but that surface belongs to the `app-versions` module this plan depends on, not to
  `public-releases` itself.

## Pass 2 — Technical Planning

### Divergence from prior art (read first)

1. **App versions are platform-global, not tenant-scoped — a real design decision, not
   an oversight.** oikos's `AppVersion` table (`database/schema/app-version.ts`) has no
   `tenantId` column at all; the PC client is one binary shipped to every tenant's
   stations, so per-tenant versioning would be actively wrong. This plan's dependency,
   `app-versions`, must therefore be a **platform-global** table — NOT RLS-scoped, NOT
   added to `APP_TENANT_TABLES` — the same treatment `.ai/rules/rbac.md` already gives
   `platform_setting`/`platform_integration`/`plan`. This is worth stating loudly here
   because every other Wave-1/Wave-2 Chrono module this migration has built so far
   *is* tenant-scoped, and a future implementer defaulting to "add tenantId, add to
   APP_TENANT_TABLES" out of habit would be wrong for this one table. Whether
   `app-versions` management belongs in `packages/agora` (a generic "distributable
   client build registry" any business app might want) or stays Chrono-specific is an
   open question for whoever plans `app-versions` — flagged here, not decided by this
   plan.
2. **oikos's `public-releases` route is not even backed by its own `app-versions` table
   — it's a live unauthenticated proxy straight to the public GitHub Releases API**,
   with an in-memory 15-minute cache and an optional token, falling back to stale cache
   on a GitHub outage. That is a materially different (and reasonable) architecture from
   what this plan's brief asks for ("tied to app-versions/app-usage tracking"): GitHub
   Releases as source of truth vs. a first-party `app-versions` registry as source of
   truth. This plan's design **prefers the first-party registry** (Chrono's own
   `app-versions` table) over a live GitHub proxy — a platform admin explicitly
   registering/promoting a version (DRAFT → PILOT → PRODUCTION, matching oikos's own
   status vocabulary, which is a sound piece of prior art worth keeping) is a safer
   control point than "whatever the latest GitHub release tag happens to be," and it
   means `public-releases` has zero external-network dependency once `app-versions`
   exists. If the developer prefers the GitHub-proxy model instead, that's a one-line
   change to this plan's "API surface" section below, not a different plan.
3. **One thing prior art got right and this plan keeps**: the short in-memory
   stale-tolerant cache pattern (serve stale on a backend hiccup rather than error) is
   the right shape for a public read endpoint — this plan applies the same instinct to
   reading the first-party `app-versions` table's PRODUCTION row, even though there's no
   external API call to protect against here; a very short TTL cache still keeps a
   scraped/linked public page off the DB on every hit, mirroring plan #1's public
   station-availability cache for the same reason.
4. **oikos ties install/download UX to `download-client.tsx` on a marketing-site
   `(landing)` route group** — a reasonable page shape to reuse conceptually
   (version list + a prominent "download latest" CTA), just not its Next.js route-group
   mechanics, which belong to oikos's own app structure.

### Where this page lives

Platform-global, not tenant-scoped — `CHRONO_DOMAIN/download` (apex-equivalent host for
Chrono, mirroring how the scaffold's own apex hosts marketing/auth). Resolved with no
tenant context at all — no `getRequestTenant()` call needed, since there's nothing
tenant-specific to resolve. This still needs its own row in
`apps/chrono-api/AGENTS.md`'s Surfaces section once implemented (this plan's blocked
Phase 1 includes that edit, deferred until unblocked).

### API surface (once `app-versions` exists)

- `GET /rpc/public/releases` — platform-global, unauthenticated, no tenant middleware,
  reads the `app-versions` table filtered to `status = 'PRODUCTION'` (or the
  as-yet-undesigned equivalent), ordered newest first, capped (e.g. last 20 releases) —
  standard pagination bound per `.ai/rules/pagination.md`, not an unbounded scan.
- No new Chrono permission resource for the *read* — same reasoning as plan #1's public
  route: no actor, nothing to gate. Whichever plan designs `app-versions`' admin
  read/write surface (register/update/promote/archive a version) will need its own
  permission resource (e.g. `appVersion: ["create","update","archive","promote"]`)
  registered the normal way via `registerAppPermissions()` — that resource does **not**
  belong to this plan; `public-releases` only ever reads.
- Short in-memory cache (a few minutes, since releases are infrequent, unlike station
  status) in front of the DB read, same rationale as plan #1.

### Schema

None owned by this plan — `app-versions`' schema is entirely out of scope here. This
plan only reads it.

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Public release list | — | `GET /rpc/public/releases` (unauth, cached, paginated) | — | — |

- Read-only surface, same as plan #1 — no mutations, no soft-delete concern, no audit
  linkage on this plan's own routes. (The `app-versions` admin CRUD this depends on will
  define its own CRUD/feedback/audit contract in its own plan.)

### Web UI (once unblocked)

- `apps/chrono-web/src/app/download/page.tsx` (or `/releases`) — server component,
  fetches the public releases list, renders with `agora/ui` primitives (`Card` per
  release, `Badge` for "mandatory update" / prerelease-equivalent flag if the eventual
  `app-versions` schema carries one). No nav entry beyond a link from wherever Chrono's
  own marketing/apex surface links to it.

## Out of Scope (this plan, even once unblocked)

- Designing `app-versions` itself (schema, admin CRUD routes, permission resource,
  promotion workflow) — a separate prerequisite plan.
- `app-usage` tracking (referenced in the task brief; also unplanned/unimplemented,
  deferred alongside `app-versions` in the migration handover's Deferred list) — not
  needed for a read-only public release list and not bundled into this plan.
- Any GitHub-proxy fallback model — only revisit if the developer explicitly prefers
  oikos's GitHub-source-of-truth approach over the first-party-registry approach this
  plan defaults to (see Divergence #2).

## Phases (BLOCKED — do not start until `app-versions` is planned and its schema phase
lands)

### Phase 0 (prerequisite, not part of this plan) — `app-versions` schema + registry

Tracked by a future, separate plan. This plan's Phase 1 cannot begin until that lands.

### Phase 1 — Public route + Surfaces doc (BLOCKED on Phase 0)

**Files to Update**
- `apps/chrono-api/src/modules/app-version/routes.ts` (or wherever `app-versions` lands
  its module — add a `publicReleaseRoutes()` factory alongside the admin routes)
- `apps/chrono-api/src/routes/rpc.ts`
- `apps/chrono-api/AGENTS.md` (Surfaces section)

**Step-by-Step Tasks**
1. Add the public, unauthenticated, cached, paginated read route described above.
2. Mount it outside `tenantMiddleware()` (there is no tenant at all here, unlike plan
   #1, which at least resolves one).
3. Document the new platform-global public surface in `apps/chrono-api/AGENTS.md`.

**Acceptance Criteria**
- Hitting the route with no session returns the current PRODUCTION-status release list,
  capped and ordered newest-first.
- No tenant context is required or accepted anywhere in the request.

**Verification Commands**
- `pnpm typecheck`

**Out-of-Scope**
- Everything in this plan's Out of Scope section.

**Execution Start Point**
- Once `app-versions`' own plan and Phase 1 (schema) are committed, re-read that
  module's `schema.ts` and `contracts.ts` before writing this route.

### Phase 2 — Web UI + E2E spec (BLOCKED on Phase 1)

**Files to Update**
- `apps/chrono-web/src/app/download/page.tsx`
- `apps/chrono-web/e2e/tests/public-releases/list.spec.ts`

**Step-by-Step Tasks**
1. Build the page per "Web UI" above.
2. E2E: happy path (a seeded PRODUCTION release appears); "public accessibility without
   a session" in place of a role gate; a DRAFT/PILOT-status release must NOT appear on
   the public list (this is this plan's isolation-equivalent assertion — not
   cross-*tenant* isolation, since there's no tenant dimension, but cross-*status*
   isolation: an unpublished build must never leak to the public feed).

**Acceptance Criteria**
- The e2e spec passes, including the DRAFT-never-leaks assertion.

**Verification Commands**
- Chrono web Playwright suite (see plan #1's Phase 2 for the runner note).

**Out-of-Scope**
- Same as Phase 1.

**Execution Start Point**
- Copy plan #1's Phase 2 e2e spec structure; adapt seeding to `app-versions` rows once
  that module's test-data helpers exist.

## Open Questions (developer to confirm/override)

1. First-party `app-versions` registry (this plan's default) vs. oikos's live
   GitHub-proxy model — confirm before `app-versions` itself is planned, since it
   determines whether `app-versions` needs a schema at all or is purely a thin GitHub
   API wrapper with a cache.
2. Where `app-versions` belongs — `packages/agora` (a generic distributable-build
   registry any business app could reuse) or Chrono-specific under
   `apps/chrono-api/src/modules/app-version/`. This plan assumes Chrono-specific (it's
   the only business app on this foundation with a native PC client today), but flags it
   for the `app-versions` plan to actually decide.
3. Platform-global admin surface for managing versions — likely a `/admin/...`
   platform-admin page (Agora staff releasing builds) rather than a tenant-dashboard
   page (no tenant owns "the PC client"), which would put it under
   `PLATFORM_PERMISSION_STATEMENTS` (`.ai/rules/rbac.md`) rather than Chrono's own
   `registerAppPermissions()` seam — another call for the `app-versions` plan to make
   explicitly, not silently default.

## Unblocking

This plan moves from `.ai/plans/chrono/blocked/public-releases/` to
`.ai/plans/chrono/active/public-releases/` once a separate `app-versions` plan exists
and its schema (Phase 0 above) is implemented and migrated. At that point, re-read this
file's Pass 1/Pass 2 (still valid), confirm the Open Questions above against whatever
`app-versions` actually shipped, and proceed to Phase 1.

## After Implementation

Not applicable until unblocked — see `.ai/rules/feature-planning.md`'s "After
Implementation" for the report shape to use once phases actually run.
