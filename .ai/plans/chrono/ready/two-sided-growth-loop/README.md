# Chrono — two-sided growth loop: reposition around players + partners

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]

## Context / why

The developer wants Chrono's marketing surface and signup mechanics rebuilt
around a two-sided network thesis: players and gaming-business partners both
need a reason to join Chrono independently, and the product should actively
convert player demand into partner acquisition ("can't find your cafe? invite
them"). This touches the apex marketing homepage
(`apps/chrono-web/src/app/(saas-landing)/page.tsx`), navigation/footer chrome
(`apps/chrono-web/src/components/landing/marketing-chrome.tsx`), and — because
the cold-start "invite a business" mechanic requires capturing player demand
for businesses that have no tenant yet — genuinely new backend surface: a
cross-tenant public business-directory read and a new Chrono-owned,
platform-global lead-capture table. This is why the plan is schema-first, not
copy-only, unlike the prior `marketing-data-driven-partners` plan on the same
page.

This plan was written after three parallel research passes across the actual
codebase (not memory) confirming what's real today. Two findings materially
change the shape of the work versus the developer's brief:

1. **Section 11's "player signup must not depend on a partner" is already
   true today**, and more fully than the brief assumed. Chrono's apex
   `/portal/sign-up` (`apps/chrono-web/src/app/(member-portal)/portal/sign-up/`)
   uses the foundation's platform-wide global `customer` pool
   (`agora/customer-auth`) with **zero tenant selection** — copy literally
   reads "One account, usable across every business you join," redirecting to
   `/portal` (global home), not any tenant dashboard. The global portal home
   (`global-portal-home.tsx`) already shows a "Your businesses" list with an
   apply-to-a-tenant flow (`apply-for-tenant-prompt.tsx` →
   `applyForTenantMembership()`) for when a player *does* find a business.
   **This plan does not rebuild player signup — it wires the new discovery/
   invite surface into what already exists**, and reuses the existing
   apply-flow as the literal "player connects to business" mechanic (event
   `PLAYER_CONNECTS_TO_BUSINESS` instruments that existing button; no new
   connect UI needed).
2. **Section 12's "partner signup must work without player demand" is also
   already true.** Chrono's apex `/sign-up`
   (`apps/chrono-web/src/app/(saas-landing)/sign-up/page.tsx`) is fully
   self-serve (`authClient.signUp.email` → `authClient.organization.create`,
   no invite code, no prerequisite beyond the platform-wide
   `disableRegistrations` kill switch). Nothing here needs to change either —
   the new work is *linking* player demand signals to this existing flow at
   signup time, not building a new signup gate.

So the genuinely new work is narrower than the brief's full 19-section spec:
the cross-tenant discovery/invite loop (backend + `/discover` page), homepage
repositioning (copy/structure only — the file the
`marketing-data-driven-partners` and `saas-landing-rebuild` plans already
touched), and lightweight analytics instrumentation. Player/partner
onboarding infrastructure itself is reused, not rebuilt.

Full research findings (verbatim, with file:line citations) are preserved in
this planning session's transcript; the load-bearing facts are folded into
Pass 2 and each phase below.

## Pass 1 — Workflow analysis

- **Who uses this:**
  - An anonymous visitor to the Chrono apex homepage, deciding whether to
    sign up as a player or inquire as a business — same audience as the
    existing homepage, but the page must now visibly split into two paths
    instead of reading as single-audience B2B.
  - A signed-in (or not-yet-signed-in) player using `/discover` to search for
    their gaming café, either finding a real Chrono partner or hitting a
    genuine empty state.
  - A player submitting an "invite this business" lead — must be a signed-in
    global customer (see Pass 2 assumption 1), landing back on `/discover`
    with a success toast.
  - A prospective partner signing up at `/sign-up` — unchanged flow, but now
    additionally sees (if any prior leads match their business name) a
    one-time "players have been asking for you" acknowledgment.
  - A tenant admin/owner checking "how much demand exists for us" via a new
    small dashboard read (`GET /rpc/growth/demand`).
- **Workflow enabled:** the growth loop itself — player discovers →
  can't find business → invites it → (async, no notification infra exists
  yet, see Out of Scope) business eventually signs up → sees accumulated
  demand → existing apply-flow connects the two.
- **Failure cases:**
  - Unauthenticated lead submission attempt → must not silently fail or
    fabricate a business record; blocked with a clear "sign in to invite a
    business" prompt (see assumption 1).
  - Zero search results → must never dead-end; always offers "invite this
    business" with the typed name pre-filled (this is the core anti-dead-end
    requirement from the brief's section 11/19).
  - A business name collision at partner signup (two different real
    businesses share a name) → the auto-match is best-effort by design (see
    Pass 2); a wrong match must not leak another tenant's data, only a lead
    record gets `matchedTenantId` reassigned, which is reversible and
    contains no other tenant's data.
  - Cross-tenant leakage: tenant A's demand-count read must never return
    tenant B's matched leads. This is the mandatory e2e case (Phase 7).
- **Audit/notifications:** the auto-match action (lead → `matchedTenantId`)
  is not a session-scoped tenant mutation (it runs at signup time, before a
  `member`/tenant context fully exists in the usual sense), so it does not
  go through `requirePermission`/`recordStaffAudit` — flagged explicitly in
  Phase 2 as a deliberate exception, mirroring how the existing tenant-landing
  public read is deliberately outside the normal tenant-mutation audit path.

## Pass 2 — Technical plan

**Boundary:** `apps/chrono-web` (marketing/discovery UI, nav, analytics) +
`apps/chrono-api` (new `business-lead` module: schema, contracts, routes,
permission). No change to `packages/agora` — see assumption 6 for why the
analytics abstraction stays app-local instead of becoming a foundation
provider.

**Nearest existing patterns reused:**
- Module structure: `apps/chrono-api/src/modules/branch/` (schema + contracts
  co-located) — the new `business-lead` module copies this shape exactly.
- Platform-global, non-RLS table: `supportTicket`/`supportTicketMessage`
  (`packages/agora/src/core/db/schema/platform.ts:655-712`) — not in
  `APP_TENANT_TABLES`, accessed via `adminDb`/`withAdmin`, filtered explicitly
  by an org FK when scoping to one tenant. `ChronoBusinessLeads` follows this
  exact shape, but as an **app-owned** platform-global table (no existing
  precedent for that combination inside `apps/chrono-api` itself — flagged as
  assumption 5, first-of-its-kind, worth a second look at audit time).
- Cross-tenant public read bypassing RLS: `readPublishedLandingPage()`
  (`packages/agora/src/core/server/routes/landing.ts:177-196`) — uses
  `withAdmin` with an explicit filter, single-tenant only today. The new
  `/public/discover/businesses` read is the same bypass pattern extended to
  **many** tenants at once (a genuine first — flagged as assumption 4, the
  single most audit-worthy piece of this plan).
- Extension seams already wired for Chrono: `apps/chrono-api/src/auth/
  permissions.ts` (`registerAppPermissions`), `apps/chrono-api/src/auth/
  require-permission.ts` (typed wrapper) — the new `growth` resource is added
  here, not to `packages/agora`.
- Homepage section pattern: every section in `(saas-landing)/page.tsx`'s apex
  branch is a local `const` data array rendered inside an `agora/ui` `<Section>`
  — new/rewritten sections follow this exactly, no new registry, no new
  primitive unless noted.

### Assumptions & explicit scope decisions (flag for developer review before/at implementation)

These are judgment calls made to keep this a "smallest coherent version"
per the brief's own section 17 — each is a place the developer or a plan
audit may want to override before Phase 1 starts:

1. **Lead submission requires a signed-in global customer** (reuses the
   already-wired `agora/customer-auth` session), rather than fully anonymous
   submission. Reason: basic spam/abuse control with zero new infrastructure,
   and it naturally ties into the brief's own story ("player signs up →
   invites business"). A fully anonymous path is future work if the developer
   wants lower friction.
2. **No external business lookup/autocomplete.** The brief's section 6
   example ("IZUR GAMING LOUNGE — Not on Chrono yet") implies knowing about
   real-world businesses Chrono has no data on — that needs a maps/places API
   integration, which does not exist in this repo today. MVP only
   distinguishes two states: "Chrono partner" (a published tenant matched the
   search) or "not found" (invite form, pre-filled with the typed name). The
   three-state "claimed/unclaimed public profile" model from the brief is
   deferred — flagged explicitly as **not built**, not silently dropped.
3. **No manual platform-admin triage console** for leads (no
   `/admin/business-leads` queue/status-change UI). MVP matching is fully
   automatic (name-normalized match at partner-signup time, see Phase 2) —
   deferred: an admin review/merge UI for ambiguous matches, per the CRUD
   matrix below.
4. **The cross-tenant discovery read is a deliberate, explicit RLS bypass**
   via `withAdmin`, read-only, returning only public directory fields (name,
   slug, logo, best-effort location text, live station counts) — never
   private tenant data. This is the same bypass class as
   `readPublishedLandingPage()`, generalized to a multi-row query. This is the
   part of the plan most worth a fresh-eyes audit before implementation.
5. **`ChronoBusinessLeads` lives in `apps/chrono-api`, not `packages/agora`**,
   per `.ai/rules/business-app.md`'s "specific to one business's product"
   branch — this feature (turning player demand into partner acquisition) was
   requested for Chrono specifically, not as a generic foundation capability.
   Per `.ai/rules/architecture.md`'s own rule of thumb ("if a second business
   app would need it too, it goes in the foundation"), if a future business
   app needs the same growth-loop mechanic, this table + its routes should be
   promoted to `packages/agora` at that time — noted here so it isn't
   forgotten, not built speculatively now.
6. **Analytics stays an app-local abstraction** (`apps/chrono-web/src/lib/
   analytics.ts`), not a new foundation provider category (even though
   `packages/agora/src/core/contracts/integrations.ts:139-149` already
   reserves an inert "analytics" platform-integration category). Building a
   full provider (interface + registry + selector + platform integration
   wiring, mirroring email/storage/billing) is a bigger foundation change
   than a marketing repositioning should introduce unasked — deferred until a
   second app needs event tracking too.
7. **No dedicated `/players` or `/partners` pages.** The homepage already
   carries full player-value and partner-value sections (Phase 5); nav links
   to them as same-page anchors (`/#for-players`, `/#for-businesses`) rather
   than forking the content into standalone routes. `/discover` **is** a real
   route because it's a genuine interactive surface (search + form), not
   marketing copy.
8. **Location matching is best-effort text, not structured geography.**
   `organization` has no address field; `ChronoBranches` has `address`/
   `latitude`/`longitude` but no `city` column. MVP search matches query text
   against organization name + each matched org's first branch (by
   `createdAt` ascending) address string — no geocoding, no radius search. A
   business with zero branches yet still matches on name.
9. **`growth:["read"]` permission grant (staff vs. admin/owner) is decided at
   implementation time** after reading the current
   `apps/chrono-api/src/auth/permissions.ts` in full — this plan specifies the
   resource and its behavior, not a guessed grant list, to avoid asserting
   exact current staff/admin/owner arrays this research pass didn't dump.

## CRUD & Feedback Contract — `BusinessLead` entity

| Op | Surface | Notes |
|---|---|---|
| Create | Public, gated on signed-in global customer | `POST /public/discover/business-leads` |
| Read (own tenant's matched count) | Tenant-scoped, `growth:read` | `GET /rpc/growth/demand` — count only, no lead PII (no requester identity returned) |
| Read (all leads, cross-tenant) | **Not built in MVP** | Deferred per assumption 3 — no admin console |
| Update (status/match) | System-only, automatic at partner-signup time | No user-facing update surface in MVP |
| Delete | **Not built in MVP** | No soft-delete needed yet — a "dismissed" status is the future equivalent if a triage console is ever built |

**Feedback contract:** lead submission shows `toast.success("Thanks — we'll
let them know you're waiting")` on success, `toast.error(...)` on validation/
auth failure (via `agora/ui`'s `sonner` re-export, per `.ai/rules/ui.md`). The
post-signup "players have been asking for you" acknowledgment is a dismissible
inline banner, not a toast (it must persist until acknowledged, not vanish in
a few seconds). **Audit linkage:** none in MVP — the automatic match is a
system action with no session actor, so `recordStaffAudit`/`recordAudit`
don't apply the way they do to an admin-triggered mutation; noted here so a
reviewer doesn't expect an audit row that legitimately shouldn't exist.

---

## Phase 1 — Schema + contracts: `ChronoBusinessLeads`

**Files to update:**
- `apps/chrono-api/src/modules/business-lead/schema.ts` (new)
- `apps/chrono-api/src/modules/business-lead/contracts.ts` (new)
- `apps/chrono-api/src/db/schema.ts` (compose the new module's schema; **do
  not** add the table to `APP_TENANT_TABLES` — it has no `tenantId` and is not
  RLS-scoped)

**Step-by-step tasks:**
1. Read `apps/chrono-api/src/modules/branch/schema.ts` in full first — copy
   its file shape (imports, `pgTable` call style, index style) exactly.
2. Define `chronoBusinessLead` → table `"ChronoBusinessLeads"`:
   - `id`: `text("id").primaryKey().$defaultFn(createId)`
   - `businessName`: `text("businessName").notNull()`
   - `city`: `text("city")` (nullable — free text, no structured geography
     exists yet per assumption 8)
   - `message`: `text("message")` (nullable)
   - `requesterCustomerId`: `text("requesterCustomerId").notNull().references(() => customer.id, { onDelete: "cascade" })`
     — import `customer` from `agora/db/schema` (the foundation's platform-wide
     global customer pool, confirmed wired in Chrono today)
   - `status`: `text("status").notNull().default("new")` — values `"new" |
     "matched"` for MVP (no `"contacted"`/`"dismissed"` yet — no console
     manages those transitions, so don't model states nothing can set)
   - `matchedTenantId`: `text("matchedTenantId").references(() => organization.id, { onDelete: "set null" })`
     (nullable) — import `organization` from `agora/db/schema`
   - `matchedAt`: `timestamp("matchedAt")` (nullable)
   - `createdAt`: `timestamp("createdAt").notNull().defaultNow()`
   - Index: `businessNameIdx` on `businessName` (used for the normalized-name
     match at signup time, Phase 2) and `matchedTenantIdx` on
     `matchedTenantId` (used by the tenant-scoped demand read).
   - **Not** added to `APP_TENANT_TABLES` — confirm this explicitly during
     review; it is the one thing most likely to be reflexively added by habit.
3. Add Zod contracts in `apps/chrono-api/src/modules/business-lead/
   contracts.ts`:
   - `createBusinessLeadSchema` — `{ businessName: z.string().min(1).max(200), city: z.string().max(200).optional(), message: z.string().max(1000).optional() }`
   - `discoverBusinessesQuerySchema` — `{ q: z.string().min(1).max(200), city: z.string().max(200).optional() }`
   - `businessDirectoryResultSchema` — the public-facing shape returned per
     matched business: `{ organizationId, name, slug, logoUrl: string | null, locationText: string | null, liveAvailability: { available: number, total: number } | null }`
     (never raw DB rows — per `.ai/rules/dto.md`)
   - `growthDemandResponseSchema` — `{ count: number }`
4. Compose the new schema file into `apps/chrono-api/src/db/schema.ts`
   alongside the other module imports.
5. Generate + apply the migration:
   `pnpm db:generate --name add_chrono_business_leads` then `pnpm db:migrate`
   (per `.ai/rules/database.md` — never `db:push`). Review the generated SQL
   for the two FKs and both indexes before applying.

**Acceptance criteria:**
- `ChronoBusinessLeads` exists in the DB with the columns/FKs/indexes above.
- The table is **not** present in `APP_TENANT_TABLES`.
- `pnpm --filter @agora/chrono-api typecheck` passes.
- `pnpm --filter @agora/api rls:proof` still prints `RLS PROOF: PASS ✅`
  (confirms this addition didn't regress any existing tenant table's forced
  RLS — required after any schema change per `.ai/rules/database.md`, even
  though this specific table isn't RLS-scoped itself).

**Verification commands:**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/api rls:proof`
- `psql $DATABASE_URL_ADMIN -c '\d "ChronoBusinessLeads"'` (or equivalent) to
  eyeball the generated schema matches the spec above.

**Out of scope:**
- Any `"contacted"`/`"dismissed"` status value or the console that would set
  them (assumption 3).
- A `city` column on `ChronoBranches`/`organization` (assumption 8).

**Execution start point:** `apps/chrono-api/src/modules/branch/schema.ts` —
read it fully, then create the new module folder mirroring its shape.

---

## Phase 2 — API routes: discovery, lead capture, demand read, auto-match

**Files to update:**
- `apps/chrono-api/src/modules/business-lead/routes.ts` (new — exports both
  a tenant-scoped factory and a standalone public router, see below)
- `apps/chrono-api/src/routes/rpc.ts` (compose the tenant-scoped
  `growthRoutes()`)
- `apps/chrono-api/src/app.ts` (mount the new public router alongside the
  existing `/public/*` mounts; hook auto-match into the existing
  organization-create path)
- `apps/chrono-api/src/auth/permissions.ts` (add `growth: ["read"]`)
- `apps/chrono-api/src/auth/require-permission.ts` (extend the typed wrapper
  if it enumerates resources explicitly — read it first to confirm)

**Step-by-step tasks:**
1. Read `apps/chrono-api/src/auth/permissions.ts` in full. Add a `growth`
   resource with `["read"]` to `CHRONO_PERMISSION_STATEMENTS`, and grant
   `read` to whichever of Chrono's own admin-level app grant objects already
   covers similarly-sensitive read-only business data (per assumption 9 —
   confirm exact grant-object names in this file before writing; do not
   guess a name that doesn't exist in the file).
2. Read `packages/agora/src/core/server/routes/landing.ts:160-196`
   (`readPublishedLandingPage`) in full — this is the pattern to mirror for
   the public discovery read's RLS-bypass justification and structure.
3. Implement `GET /public/discover/businesses` (new standalone Hono router,
   **no `tenantMiddleware`** — there is no single tenant to resolve):
   - Validate query with `discoverBusinessesQuerySchema` via `zValidator`.
   - Via `withAdmin`: select `organization` rows where `status = 'active'`
     AND a published `tenantLandingPage` exists for that org AND `name` (or
     `slug`) ILIKE the query — cite `readPublishedLandingPage`'s `withAdmin`
     usage as the justification comment, same as that function's own comment
     block.
   - For each matched org, LEFT JOIN its first `ChronoBranches` row (ORDER BY
     `createdAt` ASC LIMIT 1) for `locationText` (the branch `address`
     column) and, if `city` filter was supplied, additionally filter matches
     to those whose branch address ILIKE the city text (best-effort per
     assumption 8).
   - For each matched org, compute `liveAvailability` from `ChronoStation`
     status counts for that org's branches (reuse whatever query the existing
     per-tenant `/public/stations` route already uses, adapted to run
     cross-tenant via `withAdmin` instead of the tenant-scoped connection —
     read `apps/chrono-web/src/app/(tenant-landing)/stations/page.tsx` and its
     backing API route first to confirm the exact existing query shape before
     writing the cross-tenant version).
   - Return `businessDirectoryResultSchema[]`. Zero matches is a normal 200
     with an empty array — never a 404 (the empty state is a UI concern, not
     an API error, per Pass 1's "must never dead-end").
4. Implement `POST /public/discover/business-leads` (same standalone
   router):
   - Require an authenticated global customer session (reuse whatever
     middleware/helper the existing `/portal/customer/apply` route already
     uses to resolve the current `customer` — read
     `packages/agora/src/identity/customer-auth` first). Return 401 with a
     clear error code the web layer can render as "sign in to invite a
     business" if absent.
   - Validate body with `createBusinessLeadSchema`.
   - Rate-limit by customer id (check whether `agora/server` already exposes
     a rate-limit helper used elsewhere in the repo — e.g. the sign-in-method
     enforcement middleware in `.ai/rules/auth.md` mentions rate limiting
     conventions; reuse it if one exists as a shared utility, otherwise add a
     minimal per-customer-id in-memory or DB-backed limiter scoped to this
     route only — do not build a generic rate-limiting framework for this).
   - Insert the row via `adminDb` (this table has no tenant context to scope
     through `withTenant`).
5. Implement `GET /rpc/growth/demand` inside a normal tenant-scoped Hono
   chain (typed on `TenantVars`, composed into `routes/rpc.ts` per the
   `project` pattern): `requirePermission(c.var.tenant.permissions, {
   growth: ["read"] })`, then count `ChronoBusinessLeads` rows where
   `matchedTenantId = c.var.tenant.tenantId` via `adminDb` (this table isn't
   under RLS, so the explicit `tenantId` filter here is the only isolation —
   comment this exactly as `readPublishedLandingPage` comments its own
   bypass). Return `growthDemandResponseSchema`.
6. Implement the auto-match hook: immediately after a new `organization` is
   created via the existing sign-up flow (`authClient.organization.create` on
   the API side — read `apps/chrono-api/src/app.ts`'s Better Auth
   organization-create hook or wherever the corresponding server-side
   `organization.created` event/callback lives), normalize the new org's
   `name` (lowercase, trim, collapse whitespace) and update any
   `ChronoBusinessLeads` rows whose normalized `businessName` matches and
   whose `matchedTenantId IS NULL`, setting `matchedTenantId` + `matchedAt` +
   `status = 'matched'`. This is best-effort, not exact-string-only if that
   proves too strict in testing — but do not add fuzzy-matching (Levenshtein,
   etc.) in MVP; normalized-exact-match only, per assumption 3's "no manual
   triage to fix a bad match" constraint (a stricter match rule is safer to
   ship first).

**Acceptance criteria:**
- `GET /public/discover/businesses?q=...` returns real matches for a seeded
  published tenant, and an empty array (200, not 404) for no match.
- `POST /public/discover/business-leads` returns 401 for an unauthenticated
  request, 201 + the created lead's id for an authenticated one.
- `GET /rpc/growth/demand` returns 403 for a role without `growth:read`, and
  the correct count — scoped only to the caller's own tenant — for one that
  has it.
- Creating a new organization whose name normalized-matches an existing
  unmatched lead sets that lead's `matchedTenantId` within the same request
  cycle (or the next `GET /rpc/growth/demand` call reflects it).
- `pnpm --filter @agora/chrono-api typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-api typecheck`
- Manual: `pnpm --filter @agora/chrono-api dev`, curl each new route with a
  seeded lead + a seeded published tenant to confirm the above by hand before
  writing the Phase 7 e2e spec.

**Out of scope:**
- Fuzzy/approximate name matching (assumption 3's follow-on).
- A generic rate-limiting framework — route-local only.
- Any change to the existing tenant-scoped `/public/stations` route itself —
  only its query logic is read and adapted, not modified in place.

**Execution start point:**
`packages/agora/src/core/server/routes/landing.ts` (read `readPublishedLandingPage`
in full) and `apps/chrono-api/src/auth/permissions.ts` (read in full) before
writing any route code.

---

## Phase 3 — Web: `/discover` page + cold-start invite flow

**Files to update:**
- `apps/chrono-web/src/app/(apex-marketing)/discover/page.tsx` (new)
- `apps/chrono-web/src/app/(apex-marketing)/discover/*` supporting client
  components (search bar, business result card, invite-lead form) — place
  under a `components/` subfolder of the route per existing app conventions,
  confirm exact local convention by checking a sibling route like `support/`
  (which has `support-form.tsx` co-located) first.
- `apps/chrono-web/src/lib/discover-client.ts` (new — thin typed wrapper over
  the new `/public/discover/*` routes, mirroring `apps/chrono-web/src/lib/
  customer-client.ts`'s shape)

**Step-by-step tasks:**
1. Read `apps/chrono-web/src/app/(apex-marketing)/support/page.tsx` +
   `support-form.tsx` first — nearest existing precedent for a marketing-group
   page with a real form posting to the API.
2. Build the search UI: an `Input` + debounced-submit search (per
   `.ai/rules/component-first-ui.md` — `agora/ui` primitives only, no raw
   `<input>`), calling `GET /public/discover/businesses`.
3. Business result card: shows name, `locationText` (or "Location not listed
   yet" if null), and, when `liveAvailability` is present, "`{available}` of
   `{total}` stations available now" (only render this line when the data
   exists — never fabricate it per the brief's section 17). Card links to the
   business's own public tenant landing page (existing mechanism, host =
   `{slug}.CHRONO_DOMAIN`).
4. Empty state (zero results): headline "Can't find your gaming café?" / copy
   "Help bring them to Chrono. Tell us which gaming spot you want to see
   here." / CTA "Invite this café" opening the invite form, pre-filled with
   the typed search query as `businessName`.
5. Invite form: `businessName` (pre-filled, editable), `city` (optional),
   `message` (optional). On submit:
   - If not signed in as a global customer, do not silently fail — show a
     clear inline prompt "Sign in to invite a business" linking to
     `/portal/sign-in?next=/discover`, per Pass 1's failure-case requirement.
   - On success: `toast.success(...)` (per `.ai/rules/ui.md`'s `sonner`
     convention) and reset the form.
6. Wire `apply-for-tenant-prompt.tsx`'s existing button as the literal
   "player connects to business" action for a *found* business — confirm (by
   reading that file) whether it's already reachable from a business's public
   landing page today; if a signed-in global customer views a matched
   business's landing page and it's not already surfaced there, this phase
   adds it (small addition to the existing tenant-landing page, not a new
   flow).

**Acceptance criteria:**
- Searching for a real seeded published business returns it with a working
  link to its landing page.
- Searching for a nonsense query returns the empty state with a working
  pre-filled invite form — never a blank page or a dead end.
- Submitting the invite form while signed out shows the sign-in prompt, not a
  silent failure or a fabricated success toast.
- Submitting the invite form while signed in creates a real
  `ChronoBusinessLeads` row (verify via `psql` or the Phase 2 route directly)
  and shows a success toast.
- Works at 375px, 640px, 1024px+ viewport widths with no horizontal overflow
  (mobile-first per the brief's section 18 — the player journey is
  mobile-heavy).
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: both dev servers running, visit `/discover`, test all four
  acceptance-criteria flows by hand at the three widths above, both themes.

**Out of scope:**
- Any autocomplete/typeahead against a real-world business database
  (assumption 2).
- Notification-on-partner-join (no notification infra exists — a lead's
  requester is captured but never proactively contacted in MVP).

**Execution start point:**
`apps/chrono-web/src/app/(apex-marketing)/support/page.tsx` +
`support-form.tsx` — read both fully before creating the new route.

---

## Phase 4 — Web: hero + navigation repositioning

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx` (hero section only this
  phase — lines cited below, from the current file state; re-read before
  editing, this file has moved since these line numbers were captured)
- `apps/chrono-web/src/components/landing/marketing-chrome.tsx` (`NAV` array,
  header CTA, footer copy)

**Step-by-step tasks:**
1. Re-read `apps/chrono-web/src/app/(saas-landing)/page.tsx` lines 1-100 and
   329-470 fully before editing (file has changed since research; confirm
   current line numbers for each item below).
2. Replace the hero badge (currently `"Chrono · Venue management platform"`,
   ~line 367-368) with `"THE GAMING NETWORK"`.
3. Replace the H1 (currently `"One dashboard for every branch, every session,
   every shift."`, ~line 369-371) with `"Where gamers and gaming businesses
   connect."`.
4. Replace the subhead (currently ~line 372-376, "Chrono gives multi-branch
   venue operators...") with: `"Find gaming cafés, connect with your favorite
   spots, and discover a better way to game. Business owners can manage their
   operations and put their venue in front of Chrono players."`
5. Add three hero CTAs (replacing whatever single CTA currently exists):
   primary `"Join as a Player"` → `/portal/sign-up`; secondary `"Join as a
   Partner"` → `/sign-up`; a lighter-weight link-style CTA `"Find a Gaming
   Cafe"` → `/discover`, and below the CTA row a small text link `"Can't find
   your cafe? Invite them"` → `/discover` (deep-linked to open the empty-state
   invite form directly, e.g. `/discover?invite=1` — confirm this query-param
   hookup in Phase 3 if not already built there).
6. Remove/rewrite the `"Multi-tenant by design, with row-level isolation per
   business."` line (~line 395-398) and the comparison-table's `"Per-tenant
   row-level security enforced at the database"` row (~line 195/204) — this
   is developer language per the brief's section 9; keep the *fact* if useful
   elsewhere (e.g. folded into a "why partners can trust Chrono with their
   data" one-liner in Phase 6's business-ops section) but not as hero/trust
   copy.
7. Replace `trustCategories` (~lines 320-325: "Gaming Lounges", "Co-working
   Spaces", "Study Cafés", "Franchise Groups") with gaming-only categories:
   "iCafes", "Gaming Lounges", "Esports Venues", "Multi-Branch Chains" — per
   the brief's section 9, do not dilute the primary market with unrelated
   verticals.
8. Update `trustStats` (~lines 327-332: "Built-in workflows → 20+", "Tenant
   data isolation → Row-level") — drop the "Row-level" stat per step 6's
   reasoning; keep "Built-in workflows → 20+" (still true, still a real
   count) plus add one player-facing stat if a real one exists by this point
   in the plan (e.g. after Phase 3, "Live station visibility" is real — use
   it) rather than inventing a network-size number the brief explicitly
   forbids ("Do not overclaim marketplace scale... unless real data exists").
9. Update `marketing-chrome.tsx`'s `NAV` (~lines 51-58): replace with
   `Discover` (`/discover`), `For Players` (`/#for-players`), `For
   Businesses` (`/#for-businesses`), `How It Works` (`/#how-it-works`),
   `Pricing` (`/pricing`) — per assumption 7, no dedicated `/players`/
   `/partners` routes.
10. Replace the header CTA (~lines 90-97, currently "Request Private
    Demo"/"Book demo" linking to `/company/contact`) with `"Join Chrono"`
    linking to `/#join` (an anchor on the hero itself, per the brief's own
    nav sketch showing one primary nav CTA with the player/partner split
    living in the hero).
11. Update the footer blurb (`marketing-chrome.tsx:311-313`, currently "A
    premium internet cafe management platform for station sessions, wallets,
    and branch operations...") to reflect the two-sided positioning, e.g. "The
    gaming network connecting players and gaming businesses — session
    management, wallets, and branch operations for partners; discovery and
    connection for players."
12. Update the root layout fallback description
    (`apps/chrono-web/src/app/layout.tsx:26`) only if it still reads
    generically after this phase — it already mentions "gaming centers and
    internet cafes," which is broadly aligned; confirm during implementation
    whether a small wording tweak is worth it or whether it's fine as-is.

**Acceptance criteria:**
- Hero renders three distinct, clearly-hierarchied CTAs (player primary,
  partner secondary, discover tertiary) plus the invite text link, at 375px
  and up with no cramped/overlapping buttons.
- No occurrence of "venue management platform", "multi-tenant", "row-level
  isolation"/"row-level security", "20+ built-in workflows" as *trust/hero*
  copy remains (the "20+ built-in workflows" stat itself may stay as a real
  partner-facing capability count, per step 8 — only the isolation-model
  framing is removed).
- Nav shows Discover/For Players/For Businesses/How It Works/Pricing, in that
  order, with a single "Join Chrono" primary CTA.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: visit `/` at 375px/640px/1024px+, both themes; grep the file for
  the removed phrases to confirm none remain in hero/nav/footer copy.

**Out of scope:** every section below the hero (Phase 5) and `/discover`
itself (already built in Phase 3, only linked from here).

**Execution start point:** `apps/chrono-web/src/app/(saas-landing)/page.tsx`
lines 1-100 and 329-470, and `marketing-chrome.tsx` in full.

---

## Phase 5 — Web: full section rebuild + SEO metadata

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx` (remaining sections)
- `apps/chrono-web/src/app/(apex-marketing)/discover/page.tsx` (add
  `metadata` export)

**Step-by-step tasks:**
1. Re-read the current file end-to-end (it has grown across two prior plans
   — data-driven-partners and saas-landing-rebuild — confirm current section
   order and exact line numbers before editing).
2. Restructure sections in this order (renaming/repurposing existing
   sections where the content is already close, per "reuse existing
   functionality wherever possible"):
   - Keep the existing "data-driven partners" trust-stat section as-is
     (already accurate, already audited) — just re-verify its category chips
     don't contradict step 7 of Phase 4's gaming-only category list; if they
     do, reconcile to one consistent category list used everywhere on the
     page.
   - **For Players** (`id="for-players"`): headline `"Your favorite gaming
     spots. One place."` Bullets built only from confirmed-real capabilities:
     session history, wallet balance + top-up, loyalty tier + credit packs,
     reservations against live per-branch station status, one account across
     every business you join (the existing global-customer pitch). Do **not**
     claim favorites/following or notifications — confirmed absent.
   - **The cold-start loop** (visual, plain HTML/SVG or `agora/ui` primitives
     — not the Artifact tool, not a new charting dependency): "Can't find
     your café? → Invite them → They join → You connect" as a 4-step row,
     reusing `Card`/`Row`/icons, same visual language as the existing "How it
     works" section.
   - **For Businesses** (`id="for-businesses"`): headline `"Your gaming
     business should be where your players are."` Bullets: manage live
     gaming stations, track sessions and customer activity, manage staff
     access via existing role/member system (do not call this a "staff
     module" — it's the existing RBAC/member system, phrase accordingly),
     wallets/payments (real, PayMongo-backed), branches (real, with maps/
     hours/social links), give players a public place to discover the
     business (the new `/discover` surface), receive demand signals from
     players (the new `growth:read` count).
   - **Live availability**: headline `"Know what's available before you
     go."` — now honestly demonstrable via `/discover`'s `liveAvailability`
     field (Phase 2/3); link this section's CTA straight to `/discover`
     rather than a mockup.
   - **Business operations** (existing sections — stations/sessions/staff/
     payments/branches/reporting) — keep, but re-balance so this no longer
     dominates the page; per the brief's section 7, "support the partner
     sale, don't dominate the homepage" — trim to the strongest 4-6 bullets
     rather than an exhaustive module list.
   - **Connect both sides** (visual): Player → discovers → gaming business →
     business uses Chrono → better customer experience → more players, as a
     simple vertical flow using existing `agora/ui` primitives.
   - **Final dual CTA**: `"Join Chrono Free"` (player) / `"Become a Chrono
     Partner"` (business).
3. Add `export const metadata` (or `generateMetadata`) to the apex page (it
   currently has none, inheriting the root layout's generic fallback per
   research) targeting: gaming café, iCafe, gaming lounge, gamers, gaming
   businesses, discover gaming cafes. Add `openGraph: { title, description,
   type: "website" }` — no image unless a real OG image asset already exists
   in the repo; do not fabricate one (confirm via a quick search for an
   existing `opengraph-image` asset before deciding to add or omit it).
4. Add a `metadata` export to `/discover/page.tsx` with its own targeted
   title/description ("Discover gaming cafés and iCafes on Chrono").
5. Do not touch the tenant-host branch of this same file (the
   `!tenant`/`tenant` split at ~line 719-759) — unchanged, per every prior
   plan on this file.

**Acceptance criteria:**
- Every bullet/claim on the page traces to a confirmed-real capability from
  this plan's research (session history, wallet, reservations, loyalty,
  branches, stations, live availability, discovery, apply-to-tenant) — no
  favorites/following, no notifications, no fabricated adoption numbers.
- Page reads as two-audience from top to bottom, not B2B-dominant.
- View source / `curl` shows the new `<title>`/`<meta name="description">`/
  OpenGraph tags on both `/` and `/discover`.
- `pnpm --filter @agora/chrono-web typecheck` passes; `pnpm --filter
  @agora/chrono-web build` succeeds.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual full-page pass at 375px/640px/1024px+, both themes — check for dead
  links, CTA hierarchy confusion, and empty-state quality per the brief's
  section 19 checklist.

**Out of scope:** the tenant-host landing-page branch of this file; the
`CHRONO_LANDING_SECTIONS` registry.

**Execution start point:** re-read
`apps/chrono-web/src/app/(saas-landing)/page.tsx` end-to-end first — do not
rely on this plan's captured line numbers, the file has moved twice already.

---

## Phase 6 — Analytics event abstraction + instrumentation

**Files to update:**
- `apps/chrono-web/src/lib/analytics.ts` (new)
- Call sites: `global-sign-up-form.tsx`, `/discover` search + card + invite
  form (Phase 3 files), `(saas-landing)/sign-up/page.tsx`, the new
  partner-signup match banner (Phase 2/5), `apply-for-tenant-prompt.tsx`

**Step-by-step tasks:**
1. Define a closed union type for the seven named events (`PLAYER_SIGNUP`,
   `PLAYER_DISCOVERY_SEARCH`, `BUSINESS_VIEW`, `BUSINESS_INVITE_REQUEST`,
   `PARTNER_SIGNUP`, `PARTNER_CLAIM`, `PLAYER_CONNECTS_TO_BUSINESS`) with a
   typed props shape per event (e.g. `PLAYER_DISCOVERY_SEARCH: { query:
   string, resultCount: number }`).
2. Implement `track(event, props?)`: `console.log` in dev (no `console.log`
   left as a stray debug call elsewhere — this is the one sanctioned use,
   guarded so it never runs in production without a real destination wired),
   no-op otherwise. Structure it so a future real vendor call (e.g. `fetch` to
   a collector, or wiring the reserved `analytics` platform-integration
   category per assumption 6) is a one-function change, not a call-site
   rewrite.
3. Add one `track(...)` call at each of the seven listed sites — debounce
   `PLAYER_DISCOVERY_SEARCH` to fire once per settled query, not per
   keystroke.

**Acceptance criteria:**
- All seven events fire at the correct call site, verified via browser
  console during manual testing.
- No `console.log` remains anywhere else added by this plan (per
  `.ai/rules/code-quality.md`) — only inside `analytics.ts`'s own guarded dev
  path.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: open browser console, exercise each of the seven flows, confirm one
  log line per action with the correct props shape.

**Out of scope:** a real analytics vendor integration (assumption 6).

**Execution start point:** the seven call-site files listed above — confirm
each still exists at the path this plan expects after Phases 3-5 land.

---

## Phase 7 — E2E specs

**Files to update:**
- `apps/chrono-web/e2e/tests/growth/demand-role-gate.spec.ts` (new)
- `apps/chrono-web/e2e/tests/growth/cross-tenant-isolation.spec.ts` (new)
- `apps/chrono-web/e2e/tests/discover/search-and-invite.spec.ts` (new)

**Step-by-step tasks:**
1. Confirm the exact e2e runner/conventions currently used for
   `apps/chrono-web` (headed Playwright, no `webServer`, needs `pnpm dev`
   running first, per the pattern `.ai/rules/rbac.md`'s Testing section and
   the `marketing-data-driven-partners` plan's own Phase 1 both describe) —
   re-verify by reading one existing chrono e2e spec fully before writing
   new ones, since this research pass did not directly confirm one exists
   under `apps/chrono-web/e2e/`.
2. `demand-role-gate.spec.ts`: a `member` role without `growth:read` gets
   403 on `GET /rpc/growth/demand`; `admin`/`owner` (whichever holds the
   grant per Phase 2) gets 200 with the correct count. **This test must fail
   if `growth:read` is removed from the granted role** — per
   `.ai/rules/rbac.md`'s gate-test requirement.
3. `cross-tenant-isolation.spec.ts`: seed a lead matched to tenant A; assert
   tenant B's `GET /rpc/growth/demand` returns 0, tenant A's returns 1.
4. `search-and-invite.spec.ts`: full happy path through `/discover` — search
   finds a seeded published tenant; a nonsense search shows the empty state;
   submitting the invite form while signed in as a global customer creates a
   real lead (verified via a direct API check, not just a UI toast).

**Acceptance criteria:**
- All three specs pass locally per the confirmed runner conventions.
- The role-gate spec genuinely fails when `growth:read` is manually stripped
  from its granted role (confirm this by temporarily removing it, running the
  spec, seeing it fail, then restoring it — the standard "does this test
  actually test anything" check).

**Verification commands:**
- Whatever the confirmed invocation is from step 1 (likely `npx playwright
  test e2e/tests/growth/ e2e/tests/discover/` from `apps/chrono-web`, dev
  servers already running).

**Out of scope:** e2e coverage for the existing, unchanged player/partner
signup flows themselves (Pass 1 already established these aren't modified by
this plan).

**Execution start point:** any existing spec under `apps/chrono-web/e2e/
tests/` (or `apps/agora-web/e2e/tests/` if none exists yet for chrono-web —
confirm which) — read it fully for the exact conventions first.

---

## Phase 8 — Docs + wrap-up

**Files to update:**
- `apps/chrono-api/AGENTS.md` (add the `business-lead` module to whatever
  module list/status section already exists there)

**Step-by-step tasks:**
1. Read `apps/chrono-api/AGENTS.md` in full first.
2. Add a short section documenting: the `business-lead` module's purpose
   (cross-tenant discovery + cold-start partner acquisition), the
   `growth:["read"]` permission, and the assumption-5 note that this may be a
   foundation-promotion candidate if a second business app needs the same
   mechanic.
3. Move this plan from `.ai/plans/chrono/in-progress/two-sided-growth-loop/`
   to `.ai/plans/chrono/archive/two-sided-growth-loop/` once all phases above
   are verified, per `.ai/rules/feature-planning.md`'s Plan Closure step —
   not part of this phase's commit, a separate final commit.

**Acceptance criteria:**
- `apps/chrono-api/AGENTS.md` accurately reflects the new module.
- Plan moved to `archive/` with all phase checkboxes in the Verification
  section below marked complete.

**Verification commands:** none beyond a final `pnpm typecheck` /
`turbo run build` across the workspace.

**Out of scope:** nothing — this is the closing phase.

**Execution start point:** `apps/chrono-api/AGENTS.md`.

---

## Out of scope (whole plan)

- Any external maps/places API integration for real-world business
  autocomplete (assumption 2).
- A platform-admin business-leads triage/merge console (assumption 3).
- Fuzzy/approximate name matching for auto-match (Phase 2).
- A generic rate-limiting framework (Phase 2, route-local only).
- Promoting the analytics abstraction to a foundation provider (assumption 6).
- A `city` column on `organization`/`ChronoBranches`, or any geocoding
  (assumption 8).
- Dedicated `/players`/`/partners` standalone routes (assumption 7).
- Any notification-on-partner-join mechanism (no notification infra exists).
- Rebuilding player or partner signup — both already satisfy the brief's
  sections 11/12 today (see Context).

## Verification (overall — check off during implementation, not now)

- [ ] Phase 1: `rls:proof` passes, `ChronoBusinessLeads` not in
      `APP_TENANT_TABLES`.
- [ ] Phase 2: all four route behaviors verified manually.
- [ ] Phase 3: `/discover` happy path + empty state + invite flow verified at
      three widths, both themes.
- [ ] Phase 4: hero/nav copy audit — no leftover B2B-jargon in trust copy.
- [ ] Phase 5: full page reviewed against the confirmed-real-capabilities
      list; `build` succeeds; metadata/OG present on `/` and `/discover`.
- [ ] Phase 6: all seven events verified firing; no stray `console.log`.
- [ ] Phase 7: all three e2e specs pass, including the role-gate's
      fail-when-stripped check.
- [ ] Phase 8: `apps/chrono-api/AGENTS.md` updated; plan archived.
- [ ] `pnpm typecheck` (workspace-wide) passes.
- [ ] `pnpm --filter @agora/api rls:proof` passes.
