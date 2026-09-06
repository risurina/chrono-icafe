# Chrono — two-sided growth loop: reposition around players + partners

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]
- Audit: two-sided-growth-loop pipeline [worktree] — `plan-auditor`, verdict
  **NEEDS REVISION** (6 BLOCKER · 8 CONDITION · 3 RISK · 4 SUGGESTION). Every
  finding is resolved in place below and tagged `[audit-fix]` so each one is
  traceable to the source it came from.
- Implementation: two-sided-growth-loop pipeline [worktree]

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
   (`global-portal-home.tsx`) already shows a "Your businesses" list, and the
   apply-to-a-tenant flow (`apply-for-tenant-prompt.tsx` →
   `applyForTenantMembership()`) is reachable for when a player *does* find a
   business. **This plan does not rebuild player signup — it wires the new
   discovery/invite surface into what already exists**, and reuses the existing
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

> **Note on line numbers.** Every `file:line` reference below was re-verified
> against the worktree at audit time. They are still a hint, not a contract —
> re-read each file before editing it.

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
  - A prospective partner signing up at `/sign-up` — unchanged flow. After the
    existing post-signup redirect lands them on their **tenant dashboard**,
    they see (if any prior leads match their business name) a dismissible
    "players have been asking for you" acknowledgment.
    **[audit-fix round 2 — CONDITION 1: this was previously described as living
    on the apex `/sign-up` page. It cannot. `GET /rpc/growth/demand` sits under
    `tenantMiddleware()`, and the apex host has no tenant, so an apex caller
    401s before the handler runs (`apps/chrono-api/AGENTS.md`, "Unauthenticated
    routes"). The banner's only possible surface is the tenant dashboard, and
    it is built in Phase 3b.]**
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
  - A business name collision (two different real businesses share a name) →
    matching is **best-effort by design** and now read-time (see assumption
    10). A colliding name inflates one tenant's demand *count*; it can never
    expose a lead's contents, because the demand read returns a count and
    nothing else.
  - Cross-tenant leakage: tenant A's demand-count read must never reflect a
    lead that names tenant B. This is the mandatory e2e case (Phase 7) and —
    because this table is deliberately outside RLS — it is the **only**
    isolation proof this feature has. See "Verification" below.
- **Audit/notifications:** none. There is no system-actor mutation left to
  audit (assumption 10 removed the signup-time write entirely), and the lead
  insert is an anonymous-tier public action, the same tier as the existing
  `company-inquiry` public route, which writes no audit row either.

## Pass 2 — Technical plan

**Boundary:** `apps/chrono-web` (marketing/discovery UI, nav, analytics) +
`apps/chrono-api` (new `business-lead` module: schema, contracts, routes,
permission). **No change to `packages/agora`** — see assumption 6 (analytics)
and assumption 10 (why the auto-match hook was dropped rather than pushed into
the foundation).

**Nearest existing patterns reused:**
- Module structure: `apps/chrono-api/src/modules/branch/` (schema + contracts
  co-located) — the new `business-lead` module copies this shape exactly.
- Anonymous-tier public lead capture, already shipped in this app:
  `apps/chrono-api/src/modules/company-inquiry/public-routes.ts` — mounted
  outside `/rpc`, `createRateLimiter` + `clientIp`, explicit "never silently
  claim success while dropping the lead" stance (`:50-58`). This is the
  closest sibling to the new lead route and the pattern to copy.
  **[audit-fix — RISK: the plan previously cited only `supportTicket` and
  missed this in-app precedent.]**
- Platform-global, non-RLS table: `supportTicket`/`supportTicketMessage`
  (`packages/agora/src/core/db/schema/platform.ts:655-712`) — not in
  `APP_TENANT_TABLES`, accessed via `adminDb`, filtered explicitly by an org
  FK when scoping to one tenant. `ChronoBusinessLeads` follows this exact
  shape, but as an **app-owned** platform-global table (assumption 5).
- Cross-tenant public read bypassing RLS: `readPublishedLandingPage()`
  (`packages/agora/src/core/server/routes/landing.ts:164-196`) — uses
  `withAdmin` with an explicit filter, single-tenant only today. The new
  `/public/discover/businesses` read is the same bypass pattern extended to
  **many** tenants at once (assumption 4). Its own comment block
  (`landing.ts:164-175`) already states the rule this plan inherits verbatim:
  *`rls:proof` does not cover this route; its real proof is the cross-tenant
  e2e case.*
- Extension seams already wired for Chrono: `apps/chrono-api/src/auth/
  permissions.ts` (`registerAppPermissions`) — the new `growth` resource is
  added here, not to `packages/agora`.
- Homepage section pattern: every section in `(saas-landing)/page.tsx`'s apex
  branch is a local `const` data array rendered inside an `agora/ui` `<Section>`
  — new/rewritten sections follow this exactly, no new registry, no new
  primitive unless noted.

### Assumptions & explicit scope decisions

Each is a judgment call kept to the "smallest coherent version" per the brief's
own section 17. Items 10–13 were **added or rewritten by the plan audit**.

1. ~~**Lead submission requires a signed-in global customer**~~
   **[RESOLVED — developer decision, implemented as a follow-up commit:]**
   submission is now fully anonymous, matching
   `modules/company-inquiry/public-routes.ts`'s pattern exactly (10/hour per
   IP via the same `createRateLimiter` shape). `requesterCustomerId` on
   `ChronoBusinessLeads` is now nullable — when a global customer happens to
   already be signed in, the route still captures their id (and an
   *additional* per-customer throttle applies), but a session is never
   required. The sign-in prompt in `invite-business-form.tsx` (and its
   `discover-invite-signin-prompt` test id) is removed; `discover-client.ts`'s
   `SubmitLeadResult` no longer has an `"unauthenticated"` branch. See
   `drizzle/0024_*.sql` for the generated (not yet applied) migration.
   ~~(reuses the
   already-wired `agora/customer-auth` session), rather than fully anonymous
   submission. Reason: basic spam/abuse control with zero new infrastructure,
   and it ties into the brief's own story ("player signs up → invites
   business").
   **[audit-fix — RISK, trade-off now recorded:]** this app already has a
   *fully anonymous* apex lead-capture surface —
   `modules/company-inquiry/public-routes.ts`, throttled 10/hour per IP — so
   requiring sign-in is a deliberate divergence from the nearest in-app
   precedent, and it adds friction at exactly the cold-start moment the
   feature exists to remove (a player who cannot find their café is, by
   definition, new). Kept because per-IP throttling alone is weak against a
   lead table that drives partner outreach, and because `/portal/sign-up` is
   itself zero-friction. **This is the plan's single most reversible product
   decision — flagged for the developer.** Dropping the requirement is a
   one-line route change plus the Phase 3 sign-in prompt becoming dead code.~~
2. **No external business lookup/autocomplete.** The brief's section 6
   example implies knowing about real-world businesses Chrono has no data on —
   that needs a maps/places API integration, which does not exist in this repo.
   MVP only distinguishes two states: "Chrono partner" (a listed tenant matched
   the search) or "not found" (invite form, pre-filled with the typed name).
   The three-state "claimed/unclaimed public profile" model from the brief is
   deferred — **not built**, not silently dropped.
3. **No manual platform-admin triage console** for leads (no
   `/admin/business-leads` queue/status-change UI). Deferred: an admin
   review/merge UI, and with it any lead lifecycle state.
4. **The cross-tenant discovery read is a deliberate, explicit RLS bypass**
   via `withAdmin`, read-only, returning only public directory fields (name,
   slug, logo, best-effort location text, live station counts) — never
   private tenant data.
5. **`ChronoBusinessLeads` lives in `apps/chrono-api`, not `packages/agora`**,
   per `.ai/rules/business-app.md`'s "specific to one business's product"
   branch. If a future business app needs the same growth-loop mechanic, this
   table + its routes should be promoted to `packages/agora` at that time —
   noted so it isn't forgotten, not built speculatively now.
6. **Analytics stays an app-local abstraction** (`apps/chrono-web/src/lib/
   analytics.ts`), not a new foundation provider category (even though
   `packages/agora/src/core/contracts/integrations.ts` already reserves an
   inert "analytics" platform-integration category). Building a full provider
   is a bigger foundation change than a marketing repositioning should
   introduce unasked — deferred until a second app needs event tracking too.
7. **No dedicated `/players` or `/partners` pages.** The homepage carries full
   player-value and partner-value sections (Phase 5); nav links to them as
   same-page anchors. `/discover` **is** a real route because it's a genuine
   interactive surface (search + form), not marketing copy.
8. **Location matching is best-effort text, not structured geography.**
   `organization` has no address field; `ChronoBranches` has `address`/
   `latitude`/`longitude` but no `city` column. MVP search matches query text
   against organization name + each matched org's first branch (by `createdAt`
   ascending) address string — no geocoding, no radius search. A business with
   zero branches still matches on name.
9. **`growth: ["read"]` is granted to `admin` only — NOT to `staff`.**
   **[audit-fix — CONDITION: this was left "decide at implementation time",
   which the audit correctly refused.]** Resolved against the actual file
   (`apps/chrono-api/src/auth/permissions.ts`, 197 lines, read in full):
   - The nearest *shape* precedent is `appUsage: ["read"]`, a read-only Chrono
     resource granted to **both** `CHRONO_STAFF_GRANTS` and
     `CHRONO_ADMIN_GRANTS`. Copying it verbatim would leave **no boundary at
     all**, and Phase 7's role-gate spec would then be asserting
     deny-by-default plumbing (`"member"` is a customer-pool value refused
     before any lookup) — which `.ai/rules/rbac.md` explicitly rejects: *"if it
     passes either way, it is testing plumbing, not the gate."*
   - The nearest *sensitivity* precedents are `report: ["readFinancial"]`,
     `promo: ["manage"]` and `landingPage: ["manage"]` — all admin-only.
     Aggregate acquisition-demand data is commercial/marketing intelligence in
     the same family as `landingPage` (which this feature is a direct
     extension of), not front-desk operational data.
   - Therefore: `CHRONO_ADMIN_GRANTS.growth = ["read"]`, and **no
     `CHRONO_STAFF_GRANTS` entry**. The gate becomes real and testable:
     `staff` → 403, `admin`/`owner` → 200.
10. **[audit-fix — BLOCKER 1] There is no signup-time auto-match hook. Matching
    is resolved lazily at read time.** The original plan said to hook "wherever
    the server-side organization-create callback lives." It lives in the
    **foundation** — `packages/agora/src/identity/auth/index.ts:298-306`
    (`organizationHooks.afterCreateOrganization`) — because `chrono-api` hands
    `/api/auth/*` wholesale to Better Auth (`apps/chrono-api/src/app.ts:547`)
    and every Chrono hook on that path is *pre*-handler `.use()` middleware.
    Three options existed; two are ruled out on documented grounds:
    - *(a) Add a foundation seam for org-creation callbacks.* Ruled out **for
      this plan**: it is a `packages/agora` change, so per
      `.ai/rules/feature-planning.md` it needs its own plan under
      `.ai/plans/agora/` and would directly contradict this plan's stated
      "no change to `packages/agora`" boundary. Recorded as the right long-term
      home if a second consumer ever appears.
    - *(c) A post-handler Hono middleware reading the created org out of the
      `POST /api/auth/organization/create` response body.* Ruled out: parsing
      another library's response body to trigger a write is fragile, silently
      breaks on any Better Auth response-shape change, and has no precedent in
      this repo.
    - **(b) Lazy read-time match — chosen.** `GET /rpc/growth/demand`
      normalizes the *caller's own* organization name (resolved from
      `c.var.tenant.tenantId`, never client input) and counts
      `ChronoBusinessLeads` rows whose stored normalized name equals it.
    Consequences, all improvements or neutral:
    - **Phase 1's schema shrinks**: `matchedTenantId`, `matchedAt` and `status`
      are all **removed** — nothing would ever set them. `businessName` gains a
      sibling `businessNameNormalized` column (written at insert) plus an index,
      so the read is one indexed equality count, not a scan.
    - **No cross-app boundary violation**, no fragile parsing, no system-actor
      write, and therefore no audit question (Pass 1 updated).
    - **Self-healing**: an organization that renames immediately picks up (or
      drops) matches, where a frozen `matchedTenantId` would have gone stale.
    - **Isolation is unchanged in kind** but simpler to reason about: the
      demand read's only isolation is a server-derived predicate, exactly as
      it would have been with `matchedTenantId`.
    - Cost: no record of *when* a lead was matched, and no per-lead history.
      Both are only meaningful to the triage console deferred in assumption 3.
11. **[audit-fix — BLOCKER 4 + the consent CONDITION] A tenant is listed in
    the public directory if and only if it has an affirmatively **published**
    foundation landing page** — `tenantLandingPage.published IS NOT NULL`.
    - The original plan's predicate ("a published `tenantLandingPage` exists")
      named a real table but ignored that Chrono reads **two** landing stores
      (`apps/chrono-api/src/app.ts:644-647`): its own legacy
      `chronoLandingPage` content columns *and* the foundation's published
      snapshot.
    - The resolution is **not** "union both". A cross-tenant apex directory is
      a *new public disclosure* — it publishes a tenant's existence, name,
      branch address and live occupancy to anyone. Consent for that must be an
      **affirmative, reversible act**. Pressing **Publish** is one. Having
      leftover legacy content columns populated is not — those predate this
      feature and were never a decision to be listed platform-wide.
    - So: foundation `published IS NOT NULL` only. A tenant with only legacy
      content is **invisible until they publish**. This fails in the safe
      direction (under-disclose, never over-disclose), and unpublishing is an
      immediate, complete opt-out that already exists in the UI.
    - Phase 8 adds a line to the tenant-facing settings copy making the
      consequence explicit: publishing a landing page also lists the business
      in Chrono's public discovery directory.
    - A dedicated tenant-controlled `listInDirectory` boolean is the better
      long-term control and is recorded as deferred follow-up work — not built
      here, because it needs a settings surface and a migration this plan
      doesn't otherwise justify.
12. **[audit-fix — RISK: PII] Lead data handling is pinned, not left implied.**
    - **Logging:** neither the lead insert nor the demand read logs any lead
      field. No `businessName`, no `city`, no `message`, no
      `requesterCustomerId` may reach application logs or an error message —
      an opaque row id only. Route errors surface as typed `HttpError`s
      carrying no row content.
    - **Never returned:** no route in this plan returns a lead row, a lead
      field, or a requester identity. The demand read is a bare
      `{ count: number }`. There is no lead-read surface at all in MVP.
    - **Analytics props carry no lead content** — see Phase 6 for the exact
      per-event prop shapes and why `PLAYER_DISCOVERY_SEARCH` deliberately
      drops the raw query string.
    - **Retention:** indefinite for now, with erasure riding the
      `requesterCustomerId` FK (`onDelete: "cascade"`) — deleting a global
      customer account removes their leads. A time-based retention sweep is
      deferred alongside the triage console (assumption 3); this is a stated
      position, not an oversight.
13. **[audit-fix — CONDITION] The whole discovery query runs inside one
    `withAdmin` transaction, and it is bounded.** `ChronoBranches`,
    `ChronoStations` and `ChronoLandingPages` are all in `APP_TENANT_TABLES`
    (RLS-forced). `withAdmin` runs on the **app** pool and sets
    `app.bypass_rls` transaction-locally; a bare `adminDb` read against those
    tables would return **zero rows silently** whenever `DATABASE_URL_ADMIN` is
    unset and `adminDb` resolves to the NOBYPASSRLS app role
    (`packages/agora/src/core/db/client.ts:13-16`). `adminDb` is therefore used
    **only** for `ChronoBusinessLeads`, which is not RLS-scoped. Bounding is
    specified in Phase 2 step 3 (hard `LIMIT`, one grouped aggregate, short
    cache).

## CRUD & Feedback Contract — `BusinessLead` entity

| Op | Surface | Notes |
|---|---|---|
| Create | Public, anonymous (RESOLVED — see assumption 1) | `POST /public/discover/business-leads` |
| Read (own tenant's demand count) | Tenant-scoped, `growth:read` (admin+) | `GET /rpc/growth/demand` — **count only**, no lead field, no requester identity, ever |
| Read (any lead's contents) | **Not built in MVP** | No surface returns a lead row (assumption 12) |
| Update | **Not built in MVP** | Nothing mutates a lead after insert (assumption 10 removed the only writer) |
| Delete | **Not built in MVP** | Erasure rides the `requesterCustomerId` cascade (assumption 12) |

**Feedback contract:** lead submission shows `toast.success("Thanks — we'll
let them know you're waiting")` on success, `toast.error(...)` on validation/
auth/rate-limit failure (via `agora/ui`'s `sonner` re-export, per
`.ai/rules/ui.md`). The "players have been asking for you" acknowledgment is a
dismissible inline banner on the **tenant dashboard** (Phase 3b), not a toast
(it must persist until acknowledged); its dismissal is stored in
`localStorage`, per-browser — deliberately not a new table and not a foundation
`tenantOnboardingDismissal` key. **[audit-fix round 2: the audit verified this
reasoning rather than taking it on trust — `tenantOnboardingDismissal`
(`packages/agora/src/core/db/schema/tenant.ts:111-127`) has **no `key`
column**; it is single-purpose, keyed `(tenantId, userId)`, its row's mere
presence being the entire state. A second dismissal type would genuinely
require a foundation schema change, a migration, and a change to
`apps/chrono-api/src/modules/onboarding/service.ts`.]** Two consequences,
recorded here so neither is later filed as a bug:
- The banner **reappears in every new browser, device and incognito window,
  indefinitely** — the demand count never decreases, so nothing else retires
  it. Tolerable for a marketing acknowledgment; not tolerable if this ever
  becomes an actionable task, at which point it needs real persistence.
- `PARTNER_CLAIM` therefore fires per browser. It is wired to the banner's
  explicit **dismiss/CTA action**, not to its impression, so the event means
  "a partner acknowledged the demand" as its name implies — not "a banner was
  rendered".
**Audit linkage:** none, and this is now correct by construction rather than by
exception — see Pass 1.

---

## Phase 1 — Schema + contracts: `ChronoBusinessLeads`

**Files to update:**
- `apps/chrono-api/src/modules/business-lead/schema.ts` (new)
- `apps/chrono-api/src/modules/business-lead/contracts.ts` (new)
- `apps/chrono-api/src/db/schema.ts` (import + re-export the new module's
  schema alongside the others; **do not** add the table to
  `APP_TENANT_TABLES` — it has no `tenantId` and is not RLS-scoped)
- `apps/chrono-api/drizzle/00NN_add_chrono_business_leads.sql` (generated)

**Step-by-step tasks:**
1. Read `apps/chrono-api/src/modules/branch/schema.ts` in full first — copy
   its file shape (imports, `pgTable` call style, index style) exactly.
2. Define `chronoBusinessLead` → table `"ChronoBusinessLeads"`:
   - `id`: `text("id").primaryKey().$defaultFn(createId)`
   - `businessName`: `text("businessName").notNull()` — as typed by the player,
     preserved for display if a triage console is ever built.
   - `businessNameNormalized`: `text("businessNameNormalized").notNull()` —
     lowercased, trimmed, internal whitespace collapsed to single spaces.
     Written at insert by a single exported helper (see task 3) so the insert
     and the demand read can never normalize differently.
     **[audit-fix — BLOCKER 1 / assumption 10: this column is what makes the
     lazy read-time match a single indexed equality instead of a scan.]**
   - `city`: `text("city")` (nullable — free text, assumption 8)
   - `message`: `text("message")` (nullable)
   - `requesterCustomerId`: `text("requesterCustomerId").notNull().references(() => base.customer.id, { onDelete: "cascade" })`
     — `customer` is the foundation's platform-wide global customer pool,
     imported via `import * as base from "agora/db/schema"` exactly as the
     other Chrono module schemas do. The cascade is the erasure path
     (assumption 12).
   - `createdAt`: `timestamp("createdAt").notNull().defaultNow()`
   - **Removed vs. the pre-audit plan:** `status`, `matchedTenantId`,
     `matchedAt` — nothing writes them under assumption 10.
   - Indexes, snake_case with the table prefix to match every existing Chrono
     table (`chrono_branch_tenant_idx`, `chrono_station_branch_idx`, …)
     **[audit-fix — SUGGESTION: the pre-audit plan used camelCase
     `businessNameIdx`, which matches nothing in this codebase]**:
     - `chrono_business_lead_name_normalized_idx` on `businessNameNormalized`
       — serves the demand count.
     - `chrono_business_lead_requester_idx` on `requesterCustomerId` — serves
       the per-customer rate-limit lookup (Phase 2) and the cascade.
   - **Not** added to `APP_TENANT_TABLES` — confirm this explicitly during
     review; it is the one thing most likely to be added reflexively by habit.
3. Add `apps/chrono-api/src/modules/business-lead/contracts.ts`:
   - `normalizeBusinessName(input: string): string` — the single shared
     normalizer (`.trim().toLowerCase().replace(/\s+/g, " ")`). Exported from
     here so the insert route, the demand read, and its unit test all use one
     implementation.
   - `createBusinessLeadSchema` — `{ businessName: z.string().trim().min(1).max(200), city: z.string().trim().max(200).optional(), message: z.string().trim().max(1000).optional() }`
   - `discoverBusinessesQuerySchema` — `{ q: z.string().trim().min(1).max(200), city: z.string().trim().max(200).optional() }`
   - `businessDirectoryResultSchema` — the public-facing shape returned per
     matched business: `{ organizationId, name, slug, logoUrl: string | null, locationText: string | null, liveAvailability: { available: number, total: number } | null }`
     (never raw DB rows — `.ai/rules/dto.md`).
     `logoUrl` resolves from `tenantBranding.logoUrl` first, falling back to
     `organization.logo`, and is `null` when neither is set.
     **[audit-fix — SUGGESTION: the source column was previously unnamed.]**
   - `growthDemandResponseSchema` — `{ count: z.number().int().nonnegative() }`
4. Import + re-export the new schema in `apps/chrono-api/src/db/schema.ts`
   alongside the other module imports (import at the top, add to the `export {}`
   block). Do **not** touch `APP_TENANT_TABLES`.
5. Generate the migration:
   `pnpm --filter @agora/chrono-api db:generate --name add_chrono_business_leads`
   **[audit-fix — BLOCKER 2: the root `db:generate`/`db:migrate`/`db:rls:proof`
   scripts are hardcoded to `@agora/api`, the scaffold, which has no Chrono
   tables at all (`.ai/rules/business-app.md` step 5 says so explicitly).
   Chrono has its own `drizzle.config.ts`, its own migration history under
   `apps/chrono-api/drizzle/`, and its own `rls:proof`.]**
   Review the generated SQL by hand for: the single FK to `"Customers"`, both
   indexes, `"businessNameNormalized"` NOT NULL, and camelCase column
   identifiers. Then apply:
   `pnpm --filter @agora/chrono-api db:migrate`.

**Acceptance criteria:**
- `ChronoBusinessLeads` exists with exactly the columns/FK/indexes above.
- The table is **not** present in `APP_TENANT_TABLES`.
- `pnpm --filter @agora/chrono-api typecheck` passes.
- `pnpm --filter @agora/chrono-api rls:proof` still prints `RLS PROOF: PASS ✅`.
  **[audit-fix — BLOCKER 2, claim corrected:]** note precisely what this does
  and does not prove. `apps/chrono-api/src/rls-proof.ts:15-20` probes only foundation tables
  (`project`, `tenantSubscriptionEvent`, `paymentTransaction`,
  `tenantMemberOAuthAccount`, `tenantMember`) — **zero Chrono tables**. A green run proves the
  app role still cannot bypass RLS and that this migration did not break the
  forced-RLS setup; it proves **nothing** about this feature's own isolation.
  That proof is Phase 7's cross-tenant e2e case. See "Verification" below.

**Verification commands:**
- `pnpm --filter @agora/chrono-api db:generate --name add_chrono_business_leads`
- `pnpm --filter @agora/chrono-api db:migrate` *(needs a live DB + `.env`)*
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` *(needs a live seeded DB + `.env`)*

**Out of scope:**
- Any lead lifecycle state or the console that would set it (assumptions 3, 10).
- A `city` column on `ChronoBranches`/`organization` (assumption 8).
- A tenant-controlled `listInDirectory` boolean (assumption 11's deferred item).

**Execution start point:** `apps/chrono-api/src/modules/branch/schema.ts` —
read it fully, then create the new module folder mirroring its shape.

---

## Phase 2 — API routes: discovery, lead capture, demand read

**Files to update:**
- `apps/chrono-api/src/modules/business-lead/routes.ts` (new — exports both a
  tenant-scoped `growthRoutes()` factory and a standalone public router)
- `apps/chrono-api/src/routes/rpc.ts` (compose `growthRoutes()`)
- `apps/chrono-api/src/app.ts` (mount the public router alongside the existing
  `/public/*` mounts; declare both new rate limiters beside the existing ones)
- `apps/chrono-api/src/auth/permissions.ts` (add `growth: ["read"]` to
  `CHRONO_PERMISSION_STATEMENTS` and to `CHRONO_ADMIN_GRANTS` **only**)
- `apps/chrono-api/src/auth/require-permission.ts` — **no change expected;
  verify only.** **[audit-fix — CONDITION:]** it derives
  `ChronoPermissionRequest` from `typeof CHRONO_PERMISSION_STATEMENTS`
  (`:18-22`); it does not enumerate resources, so adding `growth` to
  `permissions.ts` is sufficient.

**Step-by-step tasks:**
1. Read `apps/chrono-api/src/auth/permissions.ts` in full. Add
   `growth: ["read"]` to `CHRONO_PERMISSION_STATEMENTS` with a comment
   recording assumption 9's reasoning, and add `growth: ["read"]` to
   `CHRONO_ADMIN_GRANTS`. **Do not add it to `CHRONO_STAFF_GRANTS`** — the
   staff/admin boundary is the point.
2. Read `packages/agora/src/core/server/routes/landing.ts:160-196`
   (`readPublishedLandingPage`) in full — the pattern to mirror for the public
   read's `withAdmin` bypass and, verbatim, for the shape of its justification
   comment.
3. Implement `GET /public/discover/businesses` (new standalone Hono router,
   **no `tenantMiddleware`** — there is no single tenant to resolve; mounted on
   the app under `/public/*` per `apps/chrono-api/AGENTS.md`'s
   "Unauthenticated routes"):
   - Rate limit **60 requests/minute per IP**, via `createRateLimiter` +
     `clientIp` from `agora/server`, declared at the mount site in `app.ts`
     next to the existing limiters (`app.ts:166-192`). This mirrors
     `landingPageIpLimiter` (`app.ts:185`), the closest public-read analogue.
     **[audit-fix — BLOCKER 6: the pre-audit plan gave this route no limit at
     all, and told the implementer to "check whether `agora/server` exposes a
     rate-limit helper" — the exact phrasing `apps/chrono-api/AGENTS.md`
     forbids. It does exist and is used ~8 times in this file.]**
   - Validate the query with `discoverBusinessesQuerySchema` via `zValidator`.
   - **One `withAdmin` transaction covers the entire query.** Five tables are
     read inside it: `Organizations`, `TenantLandingPages` (the `published`
     eligibility predicate), `TenantBrandings` (`logoUrl`), `ChronoBranches`
     (`locationText`) and `ChronoStations` (`liveAvailability`).
     **[audit-fix round 2 — CONDITION 4: the previous enumeration named only
     three and omitted `TenantLandingPages` and `TenantBrandings`. Both are in
     `BASE_TENANT_TABLES` (`packages/agora/src/core/db/rls.ts:26-27`) and so are
     RLS-forced; a bare `adminDb` read of either returns zero rows *silently* —
     in practice a null `logoUrl` on every card, or a silently empty
     directory.]** `adminDb` is never used in this route.
   - Tenant eligibility predicate, all three conditions:
     a. **Not** in a terminal lifecycle status — expressed **in SQL**, as
        `notInArray(organization.status, TERMINAL_TENANT_STATUSES)` inside the
        `where`, **before** the `LIMIT`.
        **[audit-fix round 2 — CONDITION 2: the previous wording said to reuse
        `isTerminalStatus`. That helper is module-private
        (`packages/agora/src/core/server/host.ts:37`, no `export`, not in the
        `agora/server` barrel — `:80` is a call site, not the definition), and
        it is a TS predicate over a status string, so it could only be applied
        in JS *after* the `LIMIT 20`. That would silently under-return, and
        could return zero matches while eligible tenants sat past the limit —
        exactly the silent-wrong-result this phase's bounding exists to
        prevent. `TERMINAL_TENANT_STATUSES` **is** exported (`host.ts:30`,
        barrel `packages/agora/src/core/server/index.ts:11`) and is already
        consumed this way by
        `apps/chrono-api/src/modules/landing-page/host-status-filter.test.ts:133`.]**
        **[audit-fix — BLOCKER 5: the pre-audit plan matched
        `status = 'active'`, which would have hidden every `trial` and
        `pending` tenant — including a business that just signed up *because a
        player invited them*, i.e. the loop's entire payoff moment.]**
     b. **Affirmatively published**: the foundation `tenantLandingPage` row for
        that org has `published IS NOT NULL`. Legacy `chronoLandingPage`
        content does **not** qualify — see assumption 11 for the consent
        reasoning. **[audit-fix — BLOCKER 4.]**
     c. `organization.name` ILIKE the query (and, when `city` is supplied,
        the joined branch address ILIKE the city text — best-effort,
        assumption 8).
   - **Bounded and non-N+1** (assumption 13, `.ai/rules/database.md` Query
     Rules): hard `LIMIT 20` on the org match; the branch and station data come
     from **one** grouped aggregate over the matched org ids, not a per-org
     loop; the whole response is cached ~15s keyed on the normalized
     `q`+`city`, mirroring the 10s per-tenant cache the single-tenant station
     route already uses (`modules/station/routes.ts:308-313`).
     **[audit-fix — CONDITION: the pre-audit plan specified "for each matched
     org, …" twice, unbounded and uncached, on an anonymous apex endpoint.]**
   - `locationText` = the org's first `ChronoBranches` row by `createdAt` ASC,
     its `address` column; `null` when the org has no branch.
   - `liveAvailability` = available/total station counts for that org's
     branches; `null` (not zero) when the org has no stations — the UI must not
     render a fabricated "0 of 0 available".
   - Return `businessDirectoryResultSchema[]` — an explicit column allowlist,
     never an un-narrowed `$inferSelect` row. Zero matches is a normal `200`
     with an empty array, never a 404 (Pass 1's "must never dead-end").
4. Implement `POST /public/discover/business-leads` (same standalone router):
   - Rate limit **10/hour per IP** *and* **10/hour per authenticated
     `customerId`**, both via `createRateLimiter` (arbitrary keys are supported
     — `packages/agora/src/identity/customer-auth/index.ts:204` uses
     `signup:ip:${clientIp(c)}`). The per-IP number matches the already-shipped
     anonymous sibling, `modules/company-inquiry/public-routes.ts:14`.
     **[audit-fix — BLOCKER 6.]**
   - Require an authenticated global customer session, reusing the same helper
     the existing `/portal/customer/apply` route uses (read
     `packages/agora/src/identity/customer-auth/` first to confirm the exact
     export). Absent → `401` with a stable error code the web layer renders as
     "sign in to invite a business".
   - Validate the body with `createBusinessLeadSchema`.
   - Insert via `adminDb` (this table has no tenant context and is not
     RLS-scoped), computing `businessNameNormalized` with the shared
     `normalizeBusinessName()` from Phase 1. `requesterCustomerId` comes from
     the resolved session, never the body.
   - Respond `201` with `{ id }` **only** — no echo of the submitted fields
     (assumption 12). Log nothing but the row id on success or failure.
   - **The 401's stable signal is the HTTP status, not a code string.**
     **[audit-fix round 2 — SUGGESTION:]** `getCustomerContext` throws
     `HttpError(401, "Not authenticated")` / `"Session expired"` — human
     messages, not machine codes. The web layer branches on `res.status === 401`
     and must never string-match the message.
5. Implement `GET /rpc/growth/demand` inside a normal tenant-scoped Hono chain
   (typed on `TenantVars`, composed into `routes/rpc.ts` per the `project`
   pattern):
   - `requirePermission(c.var.tenant.permissions, { growth: ["read"] })` at the
     very top, imported from the app-local typed wrapper
     `apps/chrono-api/src/auth/require-permission.ts`, before any DB work.
   - Resolve the caller's own organization name from
     `c.var.tenant.tenantId` — **never** client input — normalize it with the
     shared `normalizeBusinessName()`, and count `ChronoBusinessLeads` rows
     whose `businessNameNormalized` equals it, via `adminDb`.
   - Carry the same explicit comment block `readPublishedLandingPage` uses: this
     table is not under RLS, so this server-derived predicate is the *only*
     isolation on this route, and its proof is the Phase 7 cross-tenant e2e
     case, not `rls:proof`.
   - Return `growthDemandResponseSchema` — a bare count, nothing else.

**Acceptance criteria:**
- `GET /public/discover/businesses?q=…` returns a seeded, **published**,
  non-terminal tenant; returns `200` + `[]` (never 404) for no match; and does
  **not** return a tenant whose landing page is unpublished.
- `POST /public/discover/business-leads` → `401` unauthenticated, `201` + `{id}`
  authenticated, `429` past either rate limit.
- `GET /rpc/growth/demand` → `403` for `staff`, `200` + the correct count for
  `admin`/`owner`, and a count scoped strictly to the caller's own tenant.
- No route returns a lead field or a requester identity.
- `pnpm --filter @agora/chrono-api typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:e2e` *(in-process PGlite, no external
  DB — see Phase 7)*
- Manual: `pnpm --filter @agora/chrono-api dev` + curl each route *(needs
  `.env`)*

**Out of scope:**
- Fuzzy/approximate name matching — normalized-exact only.
- A generic rate-limiting framework — reuse `agora/server`'s, route-local
  numbers.
- Any change to the existing tenant-scoped `/public/stations` route itself —
  its query logic is read and adapted, not modified in place.

**Execution start point:**
`packages/agora/src/core/server/routes/landing.ts` (read
`readPublishedLandingPage` in full), `apps/chrono-api/src/auth/permissions.ts`
(read in full), and `apps/chrono-api/src/modules/company-inquiry/public-routes.ts`
(the nearest public-lead-route sibling) before writing any route code.

---

## Phase 3 — Web: `/discover` page + cold-start invite flow

**Files to update:**
- `apps/chrono-web/src/app/(apex-marketing)/discover/page.tsx` (new)
- `apps/chrono-web/src/app/(apex-marketing)/discover/discover-search.tsx`,
  `business-result-card.tsx`, `invite-business-form.tsx` (new client
  components, co-located in the route folder — the convention `support/`
  already uses with `support-form.tsx`)
- `apps/chrono-web/src/lib/discover-client.ts` (new)

**Step-by-step tasks:**
1. Read `apps/chrono-web/src/app/(apex-marketing)/support/page.tsx` +
   `support-form.tsx` first — the nearest precedent for a marketing-group page
   with a real form posting to an apex `/public/*` route.
   **[audit-fix — CONDITION, corrected expectation:]** `support-form.tsx` uses a
   **raw `fetch`** to `${process.env.NEXT_PUBLIC_API_URL}/public/company-inquiries`
   with no client helper and no tenant headers — deliberately, because an apex
   `/public/*` route has no tenant. `apps/chrono-web/src/lib/customer-client.ts`
   is a 12-line re-export barrel of `agora/client` and mirrors nothing useful
   here, so `discover-client.ts` follows `support-form.tsx`'s shape: a thin
   typed module wrapping the same raw `fetch` calls, so the two new routes have
   one call site each rather than inline fetches in three components.
2. Build the search UI: an `Input` + debounced submit (per
   `.ai/rules/component-first-ui.md` — `agora/ui` primitives only, no raw
   `<input>`), calling `GET /public/discover/businesses`.
3. Business result card: name, `locationText` (or "Location not listed yet"
   when `null`), and — **only when `liveAvailability` is non-null** — "{available}
   of {total} stations available now". Never fabricate that line. Card links to
   the business's public tenant landing page (`{slug}.CHRONO_DOMAIN`).
4. Empty state (zero results): headline "Can't find your gaming café?" / copy
   "Help bring them to Chrono. Tell us which gaming spot you want to see here."
   / CTA "Invite this café" opening the invite form pre-filled with the typed
   query as `businessName`. Also opened directly by `?invite=1` (the deep link
   Phase 4's hero text link uses).
5. Invite form: `businessName` (pre-filled, editable), `city` (optional),
   `message` (optional). On submit:
   - If not signed in as a global customer: **keep the invite form mounted and
     show the prompt inline**, preserving everything already typed. Link to
     `/portal/login` (open in a new tab) rather than navigating away. Never a
     silent failure and never a fabricated success toast.
     **[audit-fix round 2 — CONDITION 3: the previous wording pinned
     `/portal/sign-in?next=/discover`, and both halves were wrong. There is no
     `/portal/sign-in` — the global-customer sign-in is `/portal/login`
     (`apps/chrono-web/src/app/(member-portal)/portal/login/page.tsx`). And that
     form ignores `next` entirely: `global-login-form.tsx:35` hardcodes
     `location.href = "/portal"`. So a player who typed a café name, was told
     to sign in, and signed in would land on `/portal` with the typed name
     lost — a dead end at the exact cold-start moment this feature exists to
     remove, contradicting Pass 1. Of the audit's two options, (b) is chosen:
     don't navigate away at all. It is strictly smaller than adding `?next=`
     support to `global-login-form.tsx` (which would be a new deliverable in a
     shared auth file, and is NOT in scope for this plan), and it preserves the
     typed name by construction rather than by round-tripping it.]**
   - On success: `toast.success("Thanks — we've recorded your request.")` and
     reset the form. On `429`: a distinct `toast.error` explaining the throttle,
     not a generic failure.
     **[audit-fix round 2 — RISK 1: the copy was "Thanks — we'll let them know
     you're waiting", which the MVP could not honour at the time. There was no
     lead-read surface (assumption 12), no triage console (assumption 3) and
     no notification, so nobody at Chrono ever saw a lead. The copy was
     softened to something true, and the recommended follow-up below is now
     **RESOLVED — implemented as a follow-up commit:]** a best-effort
     notification is sent to `SUPPORT_INBOX_EMAIL` via `getEmailSender`,
     mirroring `modules/company-inquiry/public-routes.ts`'s send exactly
     (branded-email helper, `escapeHtml`, no tenant branding). It carries the
     business name/city/message and, when a global customer happens to be
     signed in, their name/email as "contact info" — otherwise the email says
     the submission was anonymous. The send never blocks or fails the
     request: `ChronoBusinessLeads` remains the durable record (it still backs
     the demand count), and a send failure or missing env var is logged via
     `logger.warn` and swallowed, never thrown back at the (often anonymous)
     submitter. The in-app copy stays as-is ("we've recorded your request") —
     it was already honest and does not claim outreach.
6. **Surface the existing apply-flow, don't rebuild it.**
   **[audit-fix — CONDITION, three path corrections:]**
   `apply-for-tenant-prompt.tsx` is at
   `apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx` (not
   under `(member-portal)/portal/`), and it is rendered by
   `apps/chrono-web/src/components/member/member-gate.tsx:123` — **not** by
   `global-portal-home.tsx`. Its docblock (`:10`) warns that its copy is
   asserted verbatim by
   `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts` —
   **do not reword it**. This phase only reads it to confirm reachability and
   to attach the Phase 6 `PLAYER_CONNECTS_TO_BUSINESS` event; if it is already
   reachable for a signed-in global customer viewing a matched business, this
   phase changes nothing there.

**Acceptance criteria:**
- Searching a real seeded published business returns it with a working link.
- A nonsense query returns the empty state with a working pre-filled invite
  form — never a blank page or a dead end.
- Submitting while signed out succeeds anonymously (RESOLVED — assumption 1).
- Submitting while signed in creates a real row and shows a success toast.
- No horizontal overflow at 375px / 640px / 1024px+, both themes.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: `pnpm dev:chrono`, visit `/discover`, all four flows at three widths,
  both themes *(needs `.env`)*

**Out of scope:**
- Autocomplete against a real-world business database (assumption 2).
- Notification-on-partner-join (no notification infra exists).
- Any rewording of `apply-for-tenant-prompt.tsx`'s copy.

**Execution start point:**
`apps/chrono-web/src/app/(apex-marketing)/support/page.tsx` +
`support-form.tsx` — read both fully before creating the new route.

---

## Phase 3b — Web: tenant-dashboard demand banner

**[audit-fix round 2 — CONDITION 1: this deliverable was named four times in
the pre-audit plan (Pass 1, the feedback contract, Phase 6's call-site list)
but no phase had it in Files to Update, no step created it, and no acceptance
criterion covered it — a Concreteness Gate failure. It also had the wrong
surface. It gets its own phase here.]**

**Files to update:**
- `apps/chrono-web/src/components/dashboard/growth/demand-banner.tsx` (new)
- the tenant dashboard home page that will render it — read
  `apps/chrono-web/src/app/(tenant-admin)/dashboard/page.tsx` first and mount
  it there, following whatever card/section composition that page already uses
- `apps/chrono-web/src/lib/discover-client.ts` (extend with the typed
  `GET /rpc/growth/demand` call, or use the existing dashboard rpc client if
  that page already has one — read the page first and reuse, don't add a
  second client)

**Step-by-step tasks:**
1. Read the dashboard home page in full and identify how it already composes
   cards/sections, and which client it uses for `/rpc/*` reads. Reuse both.
2. Fetch `GET /rpc/growth/demand`. **A `403` is a normal, expected response
   here**, not an error state: `growth:read` is admin-only (assumption 9), so a
   `staff` viewer simply sees no banner. Render nothing on `403`, and render
   nothing on `count === 0`.
3. On `count > 0`, render a dismissible banner built from `agora/ui`
   primitives: "{count} player{s} asked for your business on Chrono" plus a
   short line explaining it came from the public discovery page. Its CTA links
   to the tenant's own public landing-page settings (the surface that controls
   whether they are listed — assumption 11).
4. Dismissal writes a `localStorage` key; the banner stays hidden in that
   browser afterwards. Fire Phase 6's `PARTNER_CLAIM` on that explicit
   dismiss/CTA action, never on render.

**Acceptance criteria:**
- An `admin`/`owner` with matching leads sees the banner; dismissing hides it
  and it stays hidden on reload in that browser.
- A `staff` user sees no banner and no error (the `403` is swallowed by design).
- `count === 0` renders nothing at all — no empty-state card.
- The banner never displays any lead field, only the count (assumption 12).
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: sign in as admin on a tenant host with a seeded matching lead *(needs
  `.env` + a dev server)*

**Out of scope:** server-side persistence of the dismissal; any lead detail on
this surface; a notification.

**Execution start point:**
`apps/chrono-web/src/app/(tenant-admin)/dashboard/page.tsx` — read it fully
before creating the component.

---

## Phase 4 — Web: hero + navigation repositioning

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx` (hero only this phase)
- `apps/chrono-web/src/components/landing/marketing-chrome.tsx`

**Verified structural facts** (re-checked at audit time; still re-read before
editing) **[audit-fix — CONDITION]**:
- The file is **760 lines**. The **apex branch spans `:102`–`:717`**
  (`if (!tenant)` at `:102`); the tenant-host branch is `:719`–`760`. The
  pre-audit plan described only the latter's location.
- Hero badge `:367-368`; H1 `:369-371`; subhead `:372-376`.
- `trustCategories` `:320-325`; `trustStats` `:327-332`.
- **"Multi-tenant by design, with row-level isolation per business." is
  line-wrapped across `:396-397`** (`…no credit card required. Multi-tenant by`
  / `design, with row-level isolation per business.`). **A literal
  search-and-replace on the full sentence will miss it.**
- "Per-tenant row-level security enforced at the database" is at `:195`.
- `marketing-chrome.tsx`: `NAV` `:51-58`, header CTA `:90-97`, footer blurb
  **`:311-312`** (two lines, not three). **There is a second nav, `TENANT_NAV`,
  at `:105`**, which the pre-audit plan never mentioned — it serves the tenant
  host and is **out of scope**; confirm it is untouched.
- `apps/chrono-web/src/app/layout.tsx` — the title constant is at `:25` and the
  description literal at `:27`. **[audit-fix round 2 — SUGGESTION: previously
  given as `:26`/`:28`.]**
- `FOOTER_COLUMNS`' "Platform" column already carries **both** `Support` and
  `Download` (`marketing-chrome.tsx:232-233`), so task 9's move is safe —
  confirmed, not assumed. Note only `MarketingFooter` carries them;
  `TenantFooter`'s columns (`:361-376`) do not, which is correct since
  `TENANT_NAV` is out of scope.
- Grepping `apps/chrono-web/e2e/` for `marketing-cta` returns **zero** matches,
  so task 10's precautionary grep will come back empty and the attribute is
  free to keep or change.

**Step-by-step tasks:**
1. Re-read `page.tsx` `:1-120` and `:320-420` and `marketing-chrome.tsx` in
   full before editing.
2. Hero badge → `"THE GAMING NETWORK"`.
3. H1 → `"Where gamers and gaming businesses connect."`
4. Subhead → `"Find gaming cafés, connect with your favorite spots, and
   discover a better way to game. Business owners can manage their operations
   and put their venue in front of Chrono players."`
5. Three hero CTAs replacing the current single CTA: primary `"Join as a
   Player"` → `/portal/sign-up`; secondary `"Join as a Partner"` → `/sign-up`;
   link-style `"Find a Gaming Cafe"` → `/discover`. Below the CTA row, a small
   text link `"Can't find your cafe? Invite them"` → `/discover?invite=1`
   (the deep link Phase 3 step 4 implements). Give the CTA row `id="join"` so
   the nav CTA in task 9 has a real anchor.
   Also add, directly under the player CTA, a small "Already play on Chrono?
   Sign in" link → `/portal/login`.
   **[audit-fix round 2 — RISK 2: `/login` is the STAFF/partner sign-in
   (`(saas-landing)/login/page.tsx`). After this phase the nav offers "Join as
   a Player" for new players and "Login" for partners, and **nothing for a
   returning player** — `/portal/login` appears nowhere in the marketing
   chrome. In a page whose whole thesis is two equal audiences, that is a
   visible asymmetry. Putting the player sign-in beside the player CTA fixes it
   without a nav dropdown, and keeps `Login` unambiguously the partner/staff
   entry.]**
6. Remove the wrapped `:396-397` isolation sentence (edit both lines, per the
   hazard note above) and the `:195` comparison-table row. Keep the *fact* only
   if it lands naturally in Phase 5's business-operations section — not as
   hero/trust copy.
7. `trustCategories` → gaming-only: "iCafes", "Gaming Lounges", "Esports
   Venues", "Multi-Branch Chains".
8. `trustStats` → drop the "Tenant data isolation → Row-level" stat; keep
   "Built-in workflows → 20+" (a real count). Add a player-facing stat **only**
   if a real one exists once Phase 3 has landed (e.g. live station visibility)
   — never invent a network-size number.
9. `NAV` → `Discover` (`/discover`), `For Players` (`/#for-players`), `For
   Businesses` (`/#for-businesses`), `How It Works` (`/#how-it-works`),
   `Pricing` (`/pricing`), **`Login` (`/login`)**.
   **[audit-fix — drift found during implementation prep:]** the pre-audit
   nav list silently dropped `Login`, `Support` and `Download` from the current
   `NAV` (`:51-58`). Dropping the **sign-in entry point** from the marketing
   nav is a usability regression the plan never argued for, so `Login` is kept.
   `Support` and `Download` move to the footer (they already appear there) —
   confirm before removing, and if they do not, keep them in the nav too.
10. Header CTA → `"Join Chrono"` → `/#join`, replacing the current
    `/company/contact` "Request Private Demo"/"Book demo" pair. Keep the
    `data-testid="marketing-cta"` attribute — an existing e2e spec may assert
    on it; grep `apps/chrono-web/e2e/` for it before changing the element.
11. Footer blurb (`:311-312`) → two-sided positioning, e.g. "The gaming network
    connecting players and gaming businesses — session management, wallets, and
    branch operations for partners; discovery and connection for players."
12. `layout.tsx:28` — leave as-is unless it reads generically after this phase;
    it already mentions gaming centers and internet cafés.

**Acceptance criteria:**
- Three clearly-hierarchied hero CTAs plus the invite text link, no cramping at
  375px.
- No occurrence of "venue management platform", "multi-tenant", "row-level
  isolation"/"row-level security" as trust/hero copy (grep both wrapped
  fragments, not the full sentence).
  **Explicit exemption:** the FAQ answer to "Is my data isolated from other
  businesses on the platform?" keeps the phrase "row-level security enforced at
  the database" verbatim. That is not trust/hero copy — it is the precise answer
  to a question a technical buyer deliberately asked, and vaguening it there
  would make the FAQ worse. The grep will hit it; that hit is expected and
  approved, not a miss. The comparison-table row that DID carry it as trust copy
  was rewritten.
- Nav shows Discover / For Players / For Businesses / How It Works / Pricing /
  Login, with a single "Join Chrono" CTA. `TENANT_NAV` unchanged.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- `grep -n "row-level\|Multi-tenant\|venue management" apps/chrono-web/src/app/\(saas-landing\)/page.tsx`
- Manual: `/` at 375/640/1024px, both themes *(needs `.env`)*

**Out of scope:** every section below the hero (Phase 5); `TENANT_NAV`; the
tenant-host branch `:719-760`.

**Execution start point:** `apps/chrono-web/src/app/(saas-landing)/page.tsx`
`:1-120` and `:320-420`, then `marketing-chrome.tsx` in full.

---

## Phase 5 — Web: full section rebuild + SEO metadata

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx` (remaining apex sections)
- `apps/chrono-web/src/app/(apex-marketing)/discover/page.tsx` (add `metadata`)

**Step-by-step tasks:**
1. Re-read the current file end to end first — it has grown across two prior
   plans; confirm current section order and line numbers before editing.
2. Restructure the apex branch's sections in this order, repurposing existing
   ones where the content is already close:
   - Keep the existing data-driven-partners trust-stat section — already
     accurate and already audited. Reconcile its category chips with Phase 4
     step 7's gaming-only list so one list is used page-wide.
   - **For Players** (`id="for-players"`): `"Your favorite gaming spots. One
     place."` Bullets only from confirmed-real capabilities: session history,
     wallet balance + top-up, loyalty tier + credit packs, reservations against
     live per-branch station status, one account across every business you
     join. **Do not** claim favorites/following or notifications — confirmed
     absent.
   - **The cold-start loop** (visual, `agora/ui` primitives or inline SVG — not
     the Artifact tool, no new charting dependency): "Can't find your café? →
     Invite them → They join → You connect", 4 steps, same visual language as
     the existing "How it works" section.
   - **For Businesses** (`id="for-businesses"`): `"Your gaming business should
     be where your players are."` Bullets: manage live gaming stations, track
     sessions and customer activity, manage staff access via the existing
     role/member system (phrase it that way — it is not a "staff module"),
     wallets/payments (real, PayMongo-backed), branches (real: maps/hours/
     social links), a public place for players to discover the business (the
     new `/discover` surface), and demand signals from players (the new
     `growth:read` count).
   - **Live availability**: `"Know what's available before you go."` — honestly
     demonstrable now via `/discover`'s `liveAvailability`; link the CTA
     straight to `/discover`, not a mockup.
   - **Business operations** (existing sections) — keep but trim to the
     strongest 4–6 bullets so this no longer dominates the page.
   - **Connect both sides** (visual): player → discovers → gaming business →
     business uses Chrono → better experience → more players.
   - **Final dual CTA**: `"Join Chrono Free"` / `"Become a Chrono Partner"`.
3. Add `export const metadata` to the apex page. **[audit-fix — CONDITION:]**
   the file currently has **no metadata export at all** — its only export is
   `export default async function Home()` at `:96`, so this is an addition, and
   it must not disturb the `!tenant`/`tenant` host branch. Target: gaming café,
   iCafe, gaming lounge, gamers, gaming businesses, discover gaming cafes. Add
   `openGraph: { title, description, type: "website" }` — **no image** unless an
   `opengraph-image` asset already exists in the repo (search first; do not
   fabricate one).
4. Add a `metadata` export to `/discover/page.tsx` ("Discover gaming cafés and
   iCafes on Chrono").
5. **Do not touch the tenant-host branch** (`:719-760`) — unchanged, per every
   prior plan on this file.

**Acceptance criteria:**
- Every claim traces to a confirmed-real capability — no favorites/following,
  no notifications, no fabricated adoption numbers.
- The page reads as two-audience top to bottom, not B2B-dominant.
- `<title>`/`<meta name="description">`/OpenGraph present on `/` and
  `/discover`.
- `pnpm --filter @agora/chrono-web typecheck` and
  `pnpm --filter @agora/chrono-web build` both pass.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual full-page pass at three widths, both themes *(needs `.env`)*

**Out of scope:** the tenant-host branch; the `CHRONO_LANDING_SECTIONS`
registry.

**Execution start point:** re-read
`apps/chrono-web/src/app/(saas-landing)/page.tsx` end to end.

---

## Phase 6 — Analytics event abstraction + instrumentation

**Files to update:**
- `apps/chrono-web/src/lib/analytics.ts` (new)
- Call sites: the `/discover` search, result card and invite form (Phase 3);
  `(member-portal)/portal/sign-up`'s form; `(saas-landing)/sign-up/page.tsx`;
  the Phase 5 partner demand banner;
  `apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx`
  **[audit-fix — CONDITION: corrected path, see Phase 3 step 6. Attach the
  event without touching that file's asserted copy.]**

**Step-by-step tasks:**
1. Define a closed union of the seven events with a typed prop shape each.
   **[audit-fix — RISK/PII: props are pinned to non-identifying values.]**
   - `PLAYER_SIGNUP: {}`
   - `PLAYER_DISCOVERY_SEARCH: { resultCount: number; hadResults: boolean }` —
     **the raw query string is deliberately excluded.** It is a user-typed
     business name heading toward an as-yet-unchosen collector; the demand it
     represents is already captured, consentfully and on purpose, by the lead
     table. Sending it to analytics as well is an unnecessary second copy.
   - `BUSINESS_VIEW: { organizationId: string }` — an org id is tenant
     metadata, not personal data.
   - `BUSINESS_INVITE_REQUEST: { hadCity: boolean; hadMessage: boolean }` —
     never the business name, city, message, email or customer id.
   - `PARTNER_SIGNUP: {}`
   - `PARTNER_CLAIM: { demandCount: number }` — fired on the Phase 3b banner's
     explicit dismiss/CTA action, **never** on render, so the name matches what
     it measures.
   - `PLAYER_CONNECTS_TO_BUSINESS: { organizationId: string }`
2. Implement `track(event, props?)`: `console.log` in dev only (guarded so it
   cannot run in production without a real destination wired — this is the one
   sanctioned `console.log` per `.ai/rules/code-quality.md`), no-op otherwise.
   Structure it so wiring a real vendor later is a one-function change, not a
   call-site rewrite.
3. Add one `track(...)` per listed site; debounce `PLAYER_DISCOVERY_SEARCH` to
   fire once per settled query, never per keystroke.

**Acceptance criteria:**
- All seven fire at the correct site with the exact prop shapes above.
- No event carries a lead field, an email, a customer id, or a raw search query.
- No stray `console.log` added anywhere else by this plan.
- `pnpm --filter @agora/chrono-web typecheck` passes.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- `grep -rn "console\.log" apps/chrono-web/src` — the only new hit is inside
  `analytics.ts`'s guarded dev path.
- Manual: browser console, exercise all seven *(needs `.env`)*

**Out of scope:** a real analytics vendor integration (assumption 6).

**Execution start point:** the call-site files above — confirm each still
exists at the stated path after Phases 3–5.

---

## Phase 7 — Tests: server-side gate + isolation, then browser specs

**[audit-fix — BLOCKER 3: the pre-audit phase added Playwright specs only. A
permission change must also be unit-tested in `permissions.test.ts` and
gate-tested in the enforced `e2e/run.ts` suite — `.ai/rules/rbac.md`,
`.ai/rules/testing.md`, `.ai/rules/business-app.md`. The exact precedent is
`appUsage`, also a read-only Chrono resource:
`apps/chrono-api/src/e2e/permissions.test.ts:1716-1736` (including a
statement-shape drift guard) and `apps/chrono-api/src/e2e/run.ts:8809-8848`
(three 403 assertions).]**

**Files to update:**
- `apps/chrono-api/src/e2e/permissions.test.ts` (extend — mirror the `appUsage`
  block, asserting the `growth` statement shape and that `staff` does **not**
  hold `growth:read` while `admin`/`owner` do)
- `apps/chrono-api/src/e2e/run.ts` (extend — a `business-lead` block: the
  `staff` 403 on `GET /rpc/growth/demand`, the `admin` 200, and the
  **cross-tenant isolation** case)
- `apps/chrono-web/e2e/tests/growth/demand-role-gate.spec.ts` (new)
- `apps/chrono-web/e2e/tests/growth/cross-tenant-isolation.spec.ts` (new)
- `apps/chrono-web/e2e/tests/discover/search-and-invite.spec.ts` (new)

**Step-by-step tasks:**
1. Read `apps/chrono-api/src/e2e/permissions.test.ts:1716-1736` and
   `apps/chrono-api/src/e2e/run.ts:8809-8848` (the `appUsage` blocks) in full,
   and mirror them.
2. **Server-side gate** (`run.ts`): `staff` → 403 on `GET /rpc/growth/demand`;
   `admin` → 200. This must fail if `growth:read` is removed from
   `CHRONO_ADMIN_GRANTS` **or** added to `CHRONO_STAFF_GRANTS`.
3. **Server-side isolation** (`run.ts`): with the harness's two seeded tenants,
   insert one lead whose normalized name equals tenant A's org name; assert
   tenant A's demand count is 1 and tenant B's is 0. **This is the feature's
   isolation proof** — `rls:proof` does not and cannot cover it (assumption 13,
   Phase 1's acceptance note).
4. **Browser specs.** Read
   `apps/chrono-web/e2e/tests/public-stations/availability.spec.ts` fully first
   — the closest precedent (its own `signUp()` helper at `:7-22`, direct API
   calls via `page.request` at `:43,69`, a second browser context for the
   cross-tenant check at `:80`, and an anonymous check via `clearCookies()` at
   `:97`). **[audit-fix — SUGGESTION:]** `apps/chrono-web/e2e/utils/` holds only
   `faker.ts`, `mailtrap-inbox.ts` and `realtime-test-publish.ts` — there is
   **no shared auth or seed helper**; every spec inlines its own signup.
   - `demand-role-gate.spec.ts` — the role gate through the real surface.
   - `cross-tenant-isolation.spec.ts` — tenant A sees its lead, tenant B sees 0.
   - `search-and-invite.spec.ts` — search finds a seeded **published** tenant;
     a nonsense search shows the empty state; an unpublished tenant does **not**
     appear; submitting the invite form signed in creates a real lead (verified
     by a direct API check, not just the toast); submitting signed out shows the
     sign-in prompt.
   Test data uses `@faker-js/faker` per `.ai/rules/e2e-testing.md`, prefixed
   `test-`.

**Acceptance criteria:**
- `pnpm --filter @agora/chrono-api test:permissions` passes.
- `pnpm --filter @agora/chrono-api test:e2e` passes, including the new block.
- The gate genuinely fails when `growth:read` is stripped from
  `CHRONO_ADMIN_GRANTS` — verify by temporarily removing it, running, seeing it
  fail, then restoring.
- All three Playwright specs pass.

**Verification commands:**
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:e2e` *(in-process PGlite — runs with no
  external DB and no `.env`)*
- `pnpm --filter @agora/chrono-web e2e` *(headed, `slowMo: 350`, `workers: 1`,
  `baseURL http://localtest.me:3000`, **no `webServer`** — `pnpm dev:chrono`
  must already be running, and it needs `.env`)*

**Out of scope:** e2e coverage for the unchanged player/partner signup flows.

**Execution start point:** `apps/chrono-api/src/e2e/permissions.test.ts`
`:1716-1736`.

---

## Phase 8 — Docs + wrap-up

**Files to update:**
- `apps/chrono-api/AGENTS.md`
- the tenant landing-page settings copy (assumption 11's disclosure line)

**Step-by-step tasks:**
1. Read `apps/chrono-api/AGENTS.md` in full first.
2. Document the `business-lead` module: its purpose (cross-tenant discovery +
   cold-start partner acquisition), the `growth: ["read"]` permission and why
   it is admin-only (assumption 9), the read-time match design and why there is
   no signup hook (assumption 10), and the assumption-5 foundation-promotion
   note.
   **[audit-fix — RISK:]** explicitly disambiguate `business-lead` from the two
   existing lookalike modules — `company-inquiry` (anonymous apex B2B contact
   form) and `inquiry` (tenant-scoped staff/customer inquiry queue). A future
   reader will otherwise treat all three as duplicates.
3. Add the directory-listing disclosure to the tenant landing-page settings
   copy: publishing a landing page also lists the business in Chrono's public
   discovery directory, and unpublishing removes it (assumption 11).
4. Note in `AGENTS.md` that the apex global-customer auth routes live at
   `(member-portal)/portal/{sign-up,login}` — the current text says
   `APP_DOMAIN/customer/*`, and no `customer/` route group exists.
   **[audit-fix — drift found during implementation prep.]**
5. Move this plan from `.ai/plans/chrono/in-progress/two-sided-growth-loop/` to
   `.ai/plans/chrono/archive/two-sided-growth-loop/` once every phase above is
   verified — a separate final commit, not part of this phase's.
   **Note:** the `ready/` → `in-progress/` move plus the `Implementation:`
   claim happen in the **same commit as Phase 1**, per
   `.ai/rules/feature-planning.md`. **[audit-fix — SUGGESTION.]**

**Acceptance criteria:**
- `apps/chrono-api/AGENTS.md` accurately reflects the new module and
  distinguishes it from `company-inquiry`/`inquiry`.
- The directory-listing consequence is stated where a tenant will see it.
- Plan moved to `archive/` with the Verification checklist below completed.

**Verification commands:** a final `pnpm typecheck` (workspace-wide) and
`pnpm build`.

**Out of scope:** nothing — this is the closing phase.

**Execution start point:** `apps/chrono-api/AGENTS.md`.

---

## Out of scope (whole plan)

- Any external maps/places API integration (assumption 2).
- A platform-admin business-leads triage/merge console (assumption 3), and with
  it any lead lifecycle state or time-based retention sweep.
- Fuzzy/approximate name matching — normalized-exact only.
- A generic rate-limiting framework — `agora/server`'s, with route-local
  numbers.
- Promoting the analytics abstraction to a foundation provider (assumption 6).
- A foundation seam for org-creation hooks (assumption 10 option (a)) — needs
  its own `.ai/plans/agora/` plan if ever wanted.
- A tenant-controlled `listInDirectory` boolean (assumption 11) — publish/
  unpublish is the MVP consent control.
- A `city` column on `organization`/`ChronoBranches`, or any geocoding
  (assumption 8).
- Dedicated `/players`/`/partners` standalone routes (assumption 7).
- Any notification-on-partner-join mechanism (no notification infra exists).
- Rebuilding player or partner signup — both already satisfy the brief's
  sections 11/12 today (see Context).

## Verification (overall — check off during implementation)

> **What proves isolation for this feature.** `ChronoBusinessLeads` is
> deliberately **not** RLS-scoped, so `rls:proof` does **not** cover
> `GET /rpc/growth/demand`. Its isolation is a single server-derived predicate,
> and its proof is the cross-tenant case in `e2e/run.ts` plus
> `cross-tenant-isolation.spec.ts`. This mirrors the foundation's own stance for
> `readPublishedLandingPage` (`landing.ts:164-175`). **Do not read a green
> `rls:proof` as isolation coverage of this feature.**

> **Pre-existing red suite — measured on this branch's base, before any code.**
> `pnpm --filter @agora/chrono-api test:e2e` reports **706 passed, 73 failed**
> on the unmodified base commit. The cascade starts at one assertion:
> `resolveOrgFromRequest` (`packages/agora/src/core/server/host.ts:80`) returns
> `null` for any terminal status and `suspended` is terminal, so once the suite
> suspends the `acme` tenant every later request 404s `Unknown tenant` —
> including the **resume** call — and ~70 downstream assertions collapse with
> it. This is unrelated to this feature and **out of scope to fix here**; it
> needs its own triage (a suspended tenant appears to have no route back
> through the tested surface, which is operationally significant on its own).
> Consequence for this plan: a fully-green `test:e2e` cannot be this feature's
> gate. Phase 7 asserts on **its own new lines** within that run, and
> `pnpm --filter @agora/chrono-api test:permissions` (green on base: 419
> passed, 0 failed) is the hard gate for the permission change.

- [ ] Phase 1: migration generated + reviewed + applied; `ChronoBusinessLeads`
      **not** in `APP_TENANT_TABLES`; `chrono-api rls:proof` still green.
- [ ] Phase 2: all three route behaviours verified; `growth:read` on
      `CHRONO_ADMIN_GRANTS` only.
- [ ] Phase 3: `/discover` happy path + empty state + invite flow at three
      widths, both themes; the signed-out prompt keeps the typed name.
- [ ] Phase 3b: demand banner shows for admin with leads, is absent for staff
      (403 swallowed) and absent at `count === 0`; dismissal persists in-browser.
- [ ] Phase 4: hero/nav copy audit — both wrapped isolation fragments gone;
      `Login` retained in nav; `TENANT_NAV` untouched.
- [ ] Phase 5: every claim traces to a real capability; `build` succeeds;
      metadata/OG present on `/` and `/discover`.
- [ ] Phase 6: all seven events fire; no event carries lead content or a raw
      query; no stray `console.log`.
- [ ] Phase 7: `test:permissions` + `test:e2e` + all three Playwright specs
      pass, including the gate's fail-when-stripped check.
- [ ] Phase 8: `AGENTS.md` updated + disclosure copy added; plan archived.
- [ ] `pnpm typecheck` (workspace-wide) passes.
- [ ] `pnpm --filter @agora/chrono-api rls:proof` passes (regression check only
      — see the note above).

---

## Implementation status / handoff (branch `feature/two-sided-growth-loop`)

**All nine phases are implemented and committed** (the eight planned, plus
Phase 3b which the round-2 audit added). The plan stays in `in-progress/`
rather than `archive/` for one reason: **three verification steps could not be
run in the implementing worktree, which has no `.env`.** Nothing is known to be
wrong; it is unverified, and the difference matters here.

### What passed

| Check | Result |
|---|---|
| `pnpm typecheck` (workspace) | PASS — 7/7 |
| `pnpm --filter @agora/chrono-web build` | PASS — `/discover` registered |
| `pnpm --filter @agora/chrono-api test:permissions` | PASS — 424 passed, 0 failed |
| `pnpm --filter @agora/chrono-api test:e2e` | 710 passed / 73 failed — the 73 are PRE-EXISTING (see below) |
| Gate tamper-check | Both gates FAIL when `growth:read` moves admin→staff, as required |

### What is left to run (needs `.env` + a database)

1. `pnpm --filter @agora/chrono-api db:migrate`
   — applies `drizzle/0023_add_chrono_business_leads.sql`. The migration was
   generated with the tracked generate-and-migrate flow and hand-reviewed (one
   FK to `"Customers"` with `ON DELETE cascade`, both indexes,
   `"businessNameNormalized"` NOT NULL, camelCase identifiers, no destructive
   ops). It has **never been applied**. PGlite builds the same DDL from the
   Drizzle schema in `test:e2e`, which is why that suite exercises the table.
2. `pnpm --filter @agora/chrono-api rls:proof` — expect `RLS PROOF: PASS ✅`.
   **This is a regression check only.** `rls-proof.ts` probes five FOUNDATION
   tables and zero Chrono tables, and `ChronoBusinessLeads` is deliberately
   outside RLS, so a green run says the migration did not break forced RLS —
   it says nothing about this feature's isolation. That proof is item 3 plus
   the `run.ts` block (already green).
3. `pnpm dev:chrono`, then `pnpm --filter @agora/chrono-web e2e` for
   `e2e/tests/growth/` and `e2e/tests/discover/` — headed, `workers: 1`, no
   `webServer`, so the dev servers must already be running.

Archive this plan once 1–3 are green.

**Archived anyway, 2026-09-06, per explicit developer instruction** to close
out the in-progress plans now. Items 1–3 above are **still unrun** — code is
merged to `main` (commit `6186d64b`, including the anonymous-lead and
staff-notification follow-ups) and `pnpm typecheck` passes across all 7
workspace tasks, but the migration has never been applied and neither
`rls:proof` nor the live growth/discover e2e specs have executed. Outstanding
before this can be trusted as fully verified, in order:

1. `pnpm --filter @agora/chrono-api db:migrate` — applies
   `drizzle/0023_add_chrono_business_leads.sql` **and**
   `drizzle/0024_business_lead_requester_nullable.sql` (both generated, never
   applied — same `.env`-less constraint throughout this plan).
2. `pnpm --filter @agora/chrono-api rls:proof` — regression check only, see
   above for why it isn't this feature's isolation proof.
3. `pnpm dev:chrono`, then `pnpm --filter @agora/chrono-web e2e` for
   `e2e/tests/growth/` and `e2e/tests/discover/`.

If any of these fail, treat it as a bug against this already-archived plan
rather than silently patching and re-closing without recording what broke.

### Pre-existing red suite — NOT caused by this branch

`test:e2e` was measured at **706 passed / 73 failed on the branch base**, before
any of this work; it is 710/73 after (the same 73, plus this feature's 4). The
whole cascade starts at one assertion: `resolveOrgFromRequest`
(`packages/agora/src/core/server/host.ts:80`) returns `null` for any terminal
status, and `suspended` is terminal — so once section U suspends the `acme`
tenant, every later request 404s `Unknown tenant`, **including the resume call**,
and acme never recovers within the run. Worth its own triage: it suggests a
suspended tenant has no route back through the tested surface, which would be
operationally significant on its own. Out of scope here.

### Two pre-existing broken specs found while fixing our own

The branch's own growth specs called `${base}/rpc/...` on the Next origin
(:3000), where no `/rpc` rewrite exists — fixed in `f2b3cb36`. **Two other
specs have the identical latent bug and were left alone** as out-of-scope:

- `apps/chrono-web/e2e/tests/tenant-landing/edit-role-gate.spec.ts:92`
- `apps/chrono-web/e2e/tests/reports/role-gate.spec.ts:95`

Both assert `403` on a call that will actually return Next's `404`, so both are
role-gate tests that cannot fail for the right reason. One-line fix each:
swap `${base}` for the file's own `API_URL`.

### CI does not run these suites

`.github/workflows/ci.yml` runs `pnpm -r typecheck`, `pnpm build`, and
`pnpm test:e2e` — and root `test:e2e` is hardcoded to `@agora/api`, the
scaffold. There is no root `test:permissions`. So the growth permission gate and
the demand isolation block are compile-checked but **never executed** by CI;
they run only when someone types the filtered command. Pre-existing, and worth
fixing separately if Chrono's gates are meant to be enforced.

### Follow-up decisions (resolved, implemented as separate commits)

Both open questions this handoff originally flagged have been decided by the
developer and implemented on this same branch, after the nine phases above:

1. **Anonymous lead submission** (assumption 1). `POST
   /public/discover/business-leads` no longer requires a signed-in global
   customer — it mirrors `modules/company-inquiry/public-routes.ts`'s
   anonymous, IP-rate-limited pattern (10/hour). `requesterCustomerId` is now
   nullable; a session is captured opportunistically when one exists, never
   required. `drizzle/0024_*.sql` makes the column nullable (generated, not
   applied — same `.env`-less constraint as the rest of this plan).
2. **A real staff notification.** Submitting a lead now sends a best-effort
   email to `SUPPORT_INBOX_EMAIL` via `getEmailSender()`, mirroring
   `company-inquiry`'s send exactly. The row remains the durable record; the
   email never blocks or fails the request.

Both changes need the same unapplied-migration + not-yet-run-e2e caveats as
the rest of this plan — see "What is left to run" above, now also covering
`0024_*.sql`.
