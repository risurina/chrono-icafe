# Chrono — `tenant-landing` module

**Depends on:** `branches` (plan done, committed `b3b3550`, all 5 phases implemented —
`ChronoBranches` exists on disk; this plan reads a tenant's branch list for
hours/location display). No hard dependency on `stations`, but **cross-references plan
#1 (`public-stations`)** for host-resolution reuse — see "Relationship to
`public-stations`" below, which this plan is required to address explicitly per the
task brief.

## What this is

A per-tenant public marketing/landing page for a venue — hours, location, amenities, a
call-to-action to apply for membership or visit — distinct from the platform's own apex
marketing page (which markets Chrono/Agora itself, not one venue) and from
`public-stations` (which shows live seat availability, not venue marketing copy). Example:
`{tenantSlug}.CHRONO_DOMAIN/` or `/about` showing "Acme Gaming Lounge — open 10am–2am,
123 Main St, 40 PCs, tournaments every Friday."

## Pass 1 — Workflow Analysis

- **Who uses this**: an anonymous public visitor (same audience as `public-stations`),
  plus a tenant `admin`/`owner` who edits the page's content.
- **Workflow (visitor)**: lands on the tenant's host root or a `/about`-style path →
  sees venue name, hours, location/map link, amenities blurb, and a CTA (apply/contact/
  view live stations — linking to plan #1's page if it exists). No session required.
- **Workflow (editor)**: an `admin`/`owner` goes to
  `/dashboard/settings/landing-page` (or similar), edits the editable fields (hero text,
  amenities blurb, contact info override), saves, sees a toast, and the public page
  reflects the change on next request (no publish/approval step in this MVP).
- **What they see/click**: visitor — read-only page with CTA links. Editor — a form with
  `Input`/`Textarea` fields and a `Save` button (`agora/ui` primitives, Sonner toast on
  success/failure per `.ai/rules/component-first-ui.md`).
- **Failure cases**:
  - Unknown/terminal-status host → 404, identical treatment to plan #1.
  - No landing content configured yet (new tenant) → render sensible defaults (venue
    name from `organization.name`, branch hours/address from `ChronoBranches` if any
    exist, no amenities blurb) rather than a blank or broken page — a tenant should
    never need to configure this before the page is presentable.
  - Editor without `landingPage:manage` (see permission section) → the settings page's
    save action 403s server-side; the UI hides/disables the form per
    `.ai/rules/rbac.md` ("frontend checks are visibility only").
  - **Tenant-isolation leak**: tenant A's landing content must never render on tenant
    B's host — same host-resolution discipline as plan #1.
- **Audit/notifications**: a landing-page content edit is tenant-configuration, not a
  security-sensitive action — no dedicated audit event needed beyond what any other
  tenant-settings save already gets (if any precedent exists elsewhere in Agora for
  settings-save audit, follow it; if none does, this plan does not introduce a new audit
  category just for this).

## Pass 2 — Technical Planning

### Divergence from prior art (read first)

1. **oikos's tenant landing "detail pages" (`about`/`contact`/`faq`/`privacy`/`terms`/
   `rates`/`games`/`events`/`location`) are entirely hardcoded, tenant-agnostic copy** —
   `page.tsx`'s `publicPages` map is a static object with the exact same boilerplate
   text for every tenant except a couple of string interpolations
   (`tenant.config.publicName`). That is not a tenant landing page in any meaningful
   sense — it's one piece of shared marketing copy wearing the visited tenant's name.
   This plan explicitly does the opposite: the page's content model is genuinely
   **per-tenant editable data** (a small settings table), not a shared static template
   with a name swapped in. A tenant that wants to say something true and specific about
   its own venue must be able to.
2. **`resolveTenantPublicLanding()` (oikos, `lib/tenant-public-landing.ts`) is
   Next.js-server-side host resolution already** — this is genuinely the right pattern
   (no middleware), and this plan keeps that shape, mapped onto `getRequestTenant()`
   (`agora/next`) rather than oikos's own resolver. Worth confirming there is no
   `middleware.ts` involved on the oikos side that this plan should avoid reintroducing
   — a scan of oikos's routing files found none feeding this specific page; if a later
   read of oikos surfaces one, it is explicitly not reproduced here regardless (see the
   hard constraint at the top of this task).
3. **oikos's page has zero notion of a landing-content *edit* surface** in the files
   inspected — it's baked into the Next.js app itself (an admin would need a code
   deploy to change any of that copy). This plan adds the missing half: a real
   tenant-editable content model with a permission gate, which oikos's design never had
   to reason about because its "landing" content was developer-owned, not tenant-owned.
   This is the single biggest design gap this plan closes relative to prior art.
4. **oikos's landing page links to `/register` for membership sign-up** — a sound CTA
   pattern this plan keeps conceptually (link to Chrono's own member sign-up flow, once
   it exists on this host), without inheriting oikos's specific route shape.

### Relationship to `public-stations` (plan #1) — explicit decision

**This plan reuses plan #1's host-resolution pattern; it is not independent.** Both
pages resolve tenant identity the same way — `getRequestTenant()` on the tenant host
under `apps/chrono-web`, no middleware, no client-supplied tenant id — because that is
the one correct pattern for a public tenant-scoped page on this foundation, and having
two different "how do we resolve tenant for an anonymous visitor" implementations living
side by side in the same app would itself be the kind of drift `.ai/rules/architecture.md`
warns against ("don't scatter routing/tenant logic across pages"). Concretely:

- If plan #1 lands first, this plan's Phase 1 factors the shared "resolve tenant from
  host, 404 on unknown/terminal status" logic into one small server-only helper (e.g.
  `apps/chrono-web/src/lib/public-tenant.ts`) that both pages import, instead of each
  page inlining its own copy of the same four lines.
- If this plan lands first, plan #1's own Phase 1 should be updated to reuse the helper
  this plan introduces, rather than duplicating it — noted here so whichever plan is
  implemented second doesn't silently re-diverge.
- The two pages remain **functionally independent** beyond that shared helper — no
  shared route, no shared data model, no cross-page runtime dependency. A tenant can
  have a landing page with no stations configured yet (and vice versa).
- This plan's page links to `/stations` (plan #1's route) as one of its CTAs when
  stations exist for the tenant, and gracefully omits that link when they don't
  (checked via a cheap existence query, not by assuming plan #1 is deployed).

### Schema

New tenant-scoped table, `ChronoLandingPages` — one row per tenant (upsert-on-save, not
a list), following the `ChronoBranches` pattern:

```ts
export const chronoLandingPage = pgTable(
  "ChronoLandingPages",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" })
      .unique(), // one row per tenant
    heroTagline: text("heroTagline"),
    aboutBody: text("aboutBody"),
    amenitiesBody: text("amenitiesBody"),
    contactOverride: text("contactOverride"), // null = fall back to branch/org contact
    ctaLabel: text("ctaLabel"),
    ctaHref: text("ctaHref"),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    updatedByUserId: text("updatedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("chrono_landing_page_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_landing_page_tenant_unique_idx").on(t.tenantId),
  ],
);
```

Hours/location/amenity *structured* data (as opposed to free-text blurbs) is deliberately
NOT duplicated here — the page reads `ChronoBranches` directly for address/hours where
that data already exists, and only stores the free-text marketing copy a branch record
has no field for. This avoids a second, driftable copy of a branch's address.

### `APP_TENANT_TABLES`

Add `"ChronoLandingPages"` to `apps/chrono-api/src/db/schema.ts`'s `APP_TENANT_TABLES`.

### Contracts

`apps/chrono-api/src/modules/landing-page/contracts.ts` — `updateLandingPageSchema` (all
fields optional/nullable, `.strict()`), a response shape including the resolved branch
list for display. Follow the `branch` module's contracts file as the nearest pattern.

### Routes

`apps/chrono-api/src/modules/landing-page/routes.ts`, two routes:

- `GET /rpc/landing-page` — tenant-gated (inside `tenantMiddleware()`), any authenticated
  member reads the current content for the settings-page editor. No new permission
  needed for read beyond existing membership (mirrors how e.g. branch read works today
  for staff — confirm against the `branch` module's own read-gate precedent during
  implementation rather than assuming).
- `PATCH /rpc/landing-page` — gated `requirePermission(c.var.tenant.permissions,
  { landingPage: ["manage"] })`, upserts the tenant's single row, sets
  `updatedByUserId`/`updatedAt`.
- A **public** counterpart, `GET /rpc/public/landing-page`, mounted outside
  `tenantMiddleware()` alongside plan #1's public route (same file/pattern as
  `apps/chrono-api/src/routes/rpc.ts`'s public-route composition) — resolves tenant by
  host-derived slug the identical way plan #1 does, returns the content plus a minimal
  branch list (name, address, hours) for the public page, and whether `/stations` has any
  rows (for the conditional CTA link) — a single boolean, not the station list itself
  (that stays plan #1's job).

### Permission vocabulary — new resource, justified

New Chrono permission resource `landingPage: ["manage"]`, added to
`apps/chrono-api/src/auth/permissions.ts`'s `CHRONO_PERMISSION_STATEMENTS`/
`CHRONO_ADMIN_GRANTS` (admin+-only mutation — a public-facing marketing page is
tenant-brand-level, matching how `branding` and `domain` are treated as sensitive
foundation resources, not staff-day-to-day ones). **Reusing the foundation's
`branding` resource was considered and rejected**: `branding` (`.ai/rules/rbac.md`
context — logo/colors/theme) governs visual identity, not free-text marketing copy, and
it is a foundation-generic resource per `.ai/rules/business-app.md`'s per-app extension
seam — Chrono's own landing-page copy is exactly the kind of business-specific resource
that seam exists for, so a new `landingPage` resource in Chrono's own
`permissions.ts` is the correct home, not an edit to `packages/agora`. No staff grant —
staff does not get `landingPage:manage` in this pass (matches `branch` mutation's own
admin+-only precedent from the `branches` plan, not `station`'s staff-inclusive one,
because this is brand/public-facing content, not day-to-day floor operations).

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Landing page content | Implicit on first `PATCH` (upsert) | `GET /rpc/landing-page` (member), `GET /rpc/public/landing-page` (public) | `PATCH /rpc/landing-page` (admin+, `landingPage:manage`) | No delete — a tenant can blank fields via update, but the row itself persists (there is always exactly one row per tenant once created; "delete" has no meaningful action here) |

- No soft-delete — not applicable to a single-row-per-tenant settings table.
- Feedback: `toast.success("Landing page updated")` / `toast.error(...)` on the settings
  page's save action, per the Toaster pattern in `.ai/rules/component-first-ui.md` — no
  local `FormError`/`FormSuccess` state.
- No audit linkage beyond the `updatedByUserId`/`updatedAt` columns already on the row
  itself — this is ordinary tenant content, not a security-sensitive confirmed action
  needing a separate audit trail (unlike, say, role changes or billing overrides).

### Web UI

- Public page: `apps/chrono-web/src/app/[[...slug]]/page.tsx` or a simpler dedicated
  `apps/chrono-web/src/app/page.tsx` at the tenant host root (confirm during
  implementation whether the tenant-host root is already claimed by something else in
  `apps/chrono-web`/`apps/agora-web`'s shared routing before assuming it's free — if the
  root is taken, fall back to `/about`). Server component, uses the shared host-resolve
  helper from "Relationship to `public-stations`," renders venue name/hero/about/
  amenities/CTA plus branch hours/address, using `agora/ui` primitives only. 404 on
  unknown/terminal-status host, identical to plan #1.
- Editor: `apps/chrono-web/src/app/dashboard/settings/landing-page/page.tsx` — a form
  built from `Card`/`Label`/`Input`/`Textarea`/`Button`, gated visually with `<Can>`/
  `can()` on `landingPage:manage` (`.ai/rules/rbac.md` — visibility only, server route is
  the real gate), Sonner toast feedback.

## Out of Scope (this plan)

- Rich content/WYSIWYG editing, image uploads for the landing page (amenities photos,
  hero image) — plain text fields only in this pass; a follow-up could add
  `storedFile`-backed images using the existing file-upload surface.
- Structured hours/amenities beyond what `ChronoBranches` already carries plus this
  plan's free-text fields — no new "amenity" enum/list model.
- Multi-language content.
- SEO/meta-tag customization.
- Any coupling to `public-stations` beyond the shared host-resolve helper and the
  conditional CTA link described above.

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to Update**
- `apps/chrono-api/src/modules/landing-page/schema.ts` (new)
- `apps/chrono-api/src/db/schema.ts`

**Step-by-Step Tasks**
1. Define `chronoLandingPage` per the schema above.
2. Re-export it and add `"ChronoLandingPages"` to `APP_TENANT_TABLES`.
3. `pnpm db:generate --name add_chrono_landing_pages` + `pnpm db:migrate`.

**Acceptance Criteria**
- Migration applies cleanly; table has the unique `tenantId` constraint.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Contracts/routes (later phases).

**Execution Start Point**
- Copy `apps/chrono-api/src/modules/branch/schema.ts`'s structure exactly.

## Phase 2 — Contracts

**Security constraint (from `.ai/plans/chrono/active/security-hardening/README.md`
Phase 5):** `ctaHref` is tenant-authored input rendered into an anchor `href` on a
PUBLIC page — it is not covered by that plan's XSS section, which only handles the
text fields. `updateLandingPageSchema` must validate `ctaHref` to accept ONLY
`https://` absolute URLs or same-origin relative paths beginning `/` — reuse the
existing `assertPublicHttpsUrl` precedent (`apps/chrono-api/src/routes/rpc.ts:1579`).
A `javascript:` (or any other non-http(s), non-relative) value must be rejected at
the API layer, not merely left unrendered by the UI. The Phase 5 e2e spec must assert
this rejection explicitly.

**Files to Update**
- `apps/chrono-api/src/modules/landing-page/contracts.ts` (already landed — this
  constraint still needs to be added to its `ctaHref` field validation)

**Step-by-Step Tasks**
1. `updateLandingPageSchema` (`.strict()`, all fields optional). `ctaHref` gets the
   `https://`-or-same-origin-relative refinement described above.
2. Response contract including resolved branch summaries + `hasStations: boolean`.

**Acceptance Criteria**
- Types compile; schema round-trips through `zValidator` in a quick manual check.

**Verification Commands**
- `pnpm typecheck`

**Out-of-Scope**
- Routes.

**Execution Start Point**
- Copy `apps/chrono-api/src/modules/branch/contracts.ts`.

## Phase 3 — Permission resource, routes (member + public)

**Files to Update**
- `apps/chrono-api/src/auth/permissions.ts` (`landingPage: ["manage"]`)
- `apps/chrono-api/src/modules/landing-page/routes.ts` (new)
- `apps/chrono-api/src/routes/rpc.ts` (mount member routes inside tenantMiddleware;
  mount the public route outside it, alongside plan #1's if already landed)

**Step-by-Step Tasks**
1. Add `landingPage` to `CHRONO_PERMISSION_STATEMENTS`/`CHRONO_ADMIN_GRANTS` (no staff
   grant).
2. `GET`/`PATCH /rpc/landing-page` per the Routes section.
3. `GET /rpc/public/landing-page`, host-resolved, reusing the shared helper if
   `public-stations` has landed, or writing it fresh (and flagging the reuse TODO in a
   code comment) if this plan lands first.

**Acceptance Criteria**
- `PATCH` 403s for a `staff`-role actor; 200s for `admin`/`owner`.
- The public route returns 404 for an unknown/terminal-status host and never leaks
  tenant B's content on tenant A's host.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`;
  otherwise the module-local permission gate test pattern used by `branches`/`stations`.

**Out-of-Scope**
- Web UI.

**Execution Start Point**
- Read `apps/chrono-api/src/modules/branch/routes.ts` for the permission-gate pattern
  and, if Phase 1 of `public-stations` has landed by this point, its public-route
  factory for the host-resolution helper shape.

## Phase 4 — Web UI (public page + settings editor)

**Files to Update**
- `apps/chrono-web/src/app/page.tsx` (or `/about`, per the root-availability check)
- `apps/chrono-web/src/app/dashboard/settings/landing-page/page.tsx`
- `apps/chrono-web/src/lib/public-tenant.ts` (new shared helper, if not already added by
  `public-stations`)

**Step-by-Step Tasks**
1. Build the public page per "Web UI" above, including the conditional `/stations` CTA.
2. Build the settings editor at `apps/chrono-web/src/app/dashboard/settings/
   landing-page/page.tsx`: a `Card` containing `Label`+`Input`/`Textarea` fields for
   `heroTagline` (`Input`), `aboutBody` (`Textarea`), `amenitiesBody` (`Textarea`),
   `contactOverride` (`Input`, placeholder noting it falls back to branch/org contact
   when blank), `ctaLabel` (`Input`), `ctaHref` (`Input`) — matching
   `chronoLandingPage`'s schema fields exactly — plus a `Button` submitting a single
   upsert `PATCH`, gated visually with `<Can>`/`can()` on `landingPage:manage`, Sonner
   `toast.success`/`toast.error` feedback.
3. If `public-stations` already landed its own inline host-resolution, refactor it to
   use this plan's shared helper (or vice versa, whichever lands second).

**Acceptance Criteria**
- Editing content as `admin`/`owner` and reloading the public page (in an incognito/
  no-session context) shows the new content for every field (`heroTagline`,
  `aboutBody`, `amenitiesBody`, `contactOverride`, `ctaLabel`, `ctaHref`).
- `staff` cannot see the editor form (visibility) and a direct API call 403s (server
  gate).
- A tenant with a blank `contactOverride` falls back to branch/org contact info on
  the public page, per the schema's own null-fallback semantics.
- No raw HTML chrome introduced in `apps/chrono-web`.

**Verification Commands**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual check in two tenant subdomains for isolation.

**Out-of-Scope**
- E2E spec (Phase 5).

**Execution Start Point**
- Read `apps/agora-web/src/app/dashboard/settings/*` for the nearest existing
  tenant-settings page pattern.

## Phase 5 — E2E spec

**Files to Update**
- `apps/chrono-web/e2e/tests/tenant-landing/public-page.spec.ts` (new)
- `apps/chrono-web/e2e/tests/tenant-landing/edit-role-gate.spec.ts` (new)

**Step-by-Step Tasks**
1. Happy path: seed a tenant's landing content, visit the public page unauthenticated,
   assert the content renders.
2. Role gate: `staff` cannot save the editor form (403/hidden control);
   `admin`/`owner` can, and the change is reflected on the public page.
3. Cross-tenant isolation: tenant A's public page never shows tenant B's landing
   content, even when both have content configured.

**Acceptance Criteria**
- All three specs pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config, per `.ai/rules/rbac.md`'s Testing section).
- No `.env` present in `apps/chrono-api` while running.

**Verification Commands**
- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/tenant-landing/public-page.spec.ts e2e/tests/tenant-landing/edit-role-gate.spec.ts`
  (with `pnpm dev` already running).

**Out-of-Scope**
- Visual/design regression testing.

**Execution Start Point**
- Copy plan #1's e2e spec structure for the public-page/isolation assertions; copy an
  existing Chrono settings-page e2e spec (if one exists, e.g. under `branches/`) for the
  role-gate assertion shape.

## Open Questions (developer to confirm/override)

1. Tenant-host root (`/`) vs. a dedicated `/about` path for the public landing page —
   this plan defaults to attempting the root and falling back to `/about` if the root is
   already claimed by shared scaffold routing; confirm during Phase 4.
2. `landingPage` as a new resource (this plan's default) vs. folding it into `branding`
   — this plan argues explicitly against reuse above; revisit only if the developer
   disagrees with that reasoning.
3. Whether a tenant with zero `ChronoBranches` rows should still get a presentable
   default public page (this plan says yes — venue name + whatever free-text fields are
   set, no hours/address section) or should 404/redirect until a branch exists —
   defaults to "always presentable."

## After Implementation

Completion report per `.ai/rules/feature-planning.md`: Summary, Files changed, Commands
run, typecheck/rls:proof/e2e result, What was not implemented, Known risks (shared
host-resolve helper ordering with `public-stations` — whichever plan lands second must
do the refactor described above), Next recommended task.
