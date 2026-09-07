# Global portal home — "Gaming Lounge Directory" redesign

**Status:** draft — not yet audited, not yet accepted
**App:** chrono
**Sessions:**
- Planning: agora-a9 [10bb99]

## Blocking dependency — do not start until this clears

`.ai/plans/chrono/in-progress/member-player-route-rename/README.md` is
**actively being implemented right now** by `agora-a3 [4c723d]` (Phase 1,
folder rename `(saas-member)/portal` → `(saas-member)/member`). Every file
this plan touches lives in that tree. This plan is written against the
**post-rename** paths (`(saas-member)/member/...`); do not claim an
`Implementation:` role or touch these files until that plan's Phase 1 (ideally
Phase 2, which also edits `global-portal-home.tsx`) is committed. Re-check
`ListAgents`/`git log` before starting.

## Reference

- Screenshot: chrono1 (`chrono.izur.com.ph/member`) — dark, gold-accented
  "Gaming Lounge Directory": marketing header/footer, left sidebar
  (Dashboard/Profile/Logout), 3-col card grid per business ("CHRONO LOUNGE"
  label, description, gold "APPLY TO JOIN" / "ENTER LOUNGE PORTAL" button).
- Prior-art source (separate repo, not copied verbatim —
  `feedback_improve_dont_port_prior_art` memory): `~/karta/karta-tenant/apps/chrono-web/src/app/member/page.tsx`,
  `components/platform/landing/member/LoungeSelectorClient.tsx`,
  `layout/MemberSidebar.tsx`, `layout/MemberLayout.tsx`. Confirmed by the
  developer: that member page reuses the **landing page's own header/footer**
  (`LandingNavbarComponent`/`LandingFooterComponent`), not a bespoke chrome —
  chrono2 must do the same with its existing `MarketingHeader`/`MarketingFooter`.

## Decision (developer, this session)

Full directory: every active tenant is listed, not just ones the customer has
already joined. "Apply to Join" for a non-member, "Enter Portal" for a member.

## Pass 1 — Workflow analysis

**Who:** a signed-in global customer (`agora/customer-auth`) on the apex
(`chrono2.izur.com.ph/member`, post-rename).

**Workflow:** customer lands on `/member`, sees every active Chrono tenant as
a card, sees at a glance which ones they belong to
(`getMyTenantMemberships()`), and either enters an existing membership's
tenant `/member` page or is taken to a new tenant's `/member` page to apply
there — mirroring how `/discover`'s `BusinessResultCard` already links
cross-subdomain (`tenantHref()`, plain `<a>`, no auth handoff) and how
`global-portal-home.tsx`'s existing `tenantPortalUrl()` already builds a
cross-subdomain link for joined memberships. **No new apply-from-apex API is
needed** — `applyForTenantMembership()` is documented as targeting "the
current tenant" (`agora/client`), i.e. it only works once `tenantFetch()`
resolves to that tenant's own host, which is exactly what clicking through
achieves. The tenant's own `/member` page already prompts a visiting,
not-yet-a-member customer to apply (`components/member/apply-for-tenant-prompt.tsx`).

**Failure cases:**
- Signed-out visitor → `GlobalPortalLayout` already redirects to
  `/member/login` (post-rename `PUBLIC` array); unaffected by this plan.
- Directory list API failure → must not crash the page; render the existing
  membership list from `getMyTenantMemberships()` alone (matches
  `getMyVenueStatus()`'s existing "absorb failure silently" precedent at
  `global-portal-home.tsx:84-90`).
- A tenant that is not `active`/`trial`/`pending` (suspended/cancelled/
  archived) must not appear as a live card — reuse the existing
  `REACHABLE_STATUSES` gate.
- Directory listing must never leak a tenant's private data — the new
  read returns only `{ id, slug, name, status }`, an explicit allowlist, same
  discipline as `BusinessDirectoryResult` (`.ai/rules/dto.md`).

**Audit/notifications:** none new. No permission gate changes (customer-facing,
not staff/admin), no schema change, no RLS change — `organization` (tenant) is
already a foundation table read via `adminDb`/`withAdmin`, same as the
existing `/businesses` search route.

## Pass 2 — Technical findings

### Backend: listing "all active tenants" doesn't exist yet, `/discover` doesn't fit

`apps/chrono-api/src/modules/business-lead/routes.ts`'s
`businessLeadPublicRoutes()` `GET /businesses` requires `q: z.string().min(1)`
(`discoverBusinessesQuerySchema`, `contracts.ts:30-33`) — it is a **search**
endpoint, not a directory listing, and pulls in ranking/live-availability
logic (`service.ts`) that this page doesn't need. Reusing it by faking a
query is the wrong shape. Instead: a new, minimal, paginated read in the same
module (nearest existing pattern to copy is `/businesses` itself, minus the
search/ranking parts).

### Frontend: cross-subdomain link pattern already proven twice

`tenantHref()` (`discover/business-result-card.tsx:14-27`) and
`tenantPortalUrl()` (`(saas-member)/member/global-portal-home.tsx`, current
file `(saas-member)/portal/global-portal-home.tsx:20-24`) both build
`${protocol}//${slug}.${host}` links with no handoff. This plan adds a third,
identical helper for directory cards that aren't yet a membership — same
shape, so extract one shared helper instead of a third copy (see Files below).

### `MarketingHeader` has no `actions` override; `TenantHeader` does

`components/landing/marketing-chrome.tsx`'s `MarketingHeader` (`:71-113`)
hardcodes its `actions` (ThemeToggle + "Join Chrono" CTA). `TenantHeader`
(`:146+`) already takes an `actions` prop that **fully replaces** the default
when supplied (used by `MemberHeader` to swap in `IdentityMenu`). Giving
`MarketingHeader` the same optional `actions` prop (default = current
behavior, unchanged for every existing apex-marketing caller) is the minimal,
reuse-first way to swap in the signed-in customer's `IdentityMenu` on this one
page — mirrors an already-proven pattern instead of inventing a new header.

### Sidebar has no equivalent yet on the apex side

`components/member/member-nav.tsx` is the **tenant-side** member nav (many
items: Session/Wallet/History/…) — wrong shape and wrong data (tenant-scoped).
The apex global-identity area needs its own, much smaller nav
(Dashboard/Profile/Logout only, matching the screenshot) — new component,
`components/member/global-portal-sidebar.tsx`, not an edit to the tenant one.

### Theme: no new colors needed

`elegant-gold` (dark) is already the shipped default palette
(`apps/chrono-api/src/contracts/theme-presets.ts`, mirrored in
`app/globals.css`'s `.dark`) — `--primary` (`#d6a84f`, gold), `--background`
(`#080806`, near-black), etc. The card grid and buttons must consume these
tokens (`bg-primary`, `text-primary`, `text-muted-foreground`) exactly like
`TenantHeader`/existing member components already do — **no hardcoded gold
hex values**, per `.ai/rules/styling.md`.

## Files to update / create

Backend (`apps/chrono-api`):
- `src/modules/business-lead/contracts.ts` — add `businessDirectoryListQuerySchema`
  (just `page`/`pageSize` via `listQuerySchema`, no `q`) and
  `BusinessDirectoryListItem` (`{ id, slug, name, status }` — narrower than
  `BusinessDirectoryResult`, no ranking/availability fields).
- `src/modules/business-lead/routes.ts` — add
  `GET /businesses/directory` to `businessLeadPublicRoutes()`: reads active
  tenants (`organization.status in ('active','trial','pending')`) via
  `withAdmin`, paginated, ordered by name. No `requirePermission` (public,
  read-only, same as `/businesses`).
- `src/modules/business-lead/routes.ts` — no changes to the existing
  `/businesses` search route.

Frontend (`apps/chrono-web`):
- `src/lib/discover-client.ts` — add `listBusinessDirectory(query)` calling
  the new route, alongside the existing `searchBusinesses`.
- `src/lib/tenant-links.ts` **(new file)** — extract the shared
  `tenantHref(slug)` helper out of `discover/business-result-card.tsx`, reuse
  it from there, from `global-portal-home.tsx`'s `tenantPortalUrl`, and from
  the new directory grid. (Small dedup, not a rewrite of either call site's
  existing behavior.)
- `src/components/member/global-portal-sidebar.tsx` **(new)** — Dashboard/
  Profile/Logout, styled like the screenshot's left rail, built from `agora/ui`
  primitives only (`.ai/rules/component-first-ui.md`).
- `src/components/member/lounge-directory-card.tsx` **(new)** — one card:
  name, "CHRONO LOUNGE" eyebrow (`text-primary`), description (from the
  existing `isMember`-branching copy already written in `LoungeSelectorClient`
  as the UX reference, not copied code), gold CTA (`Enter Portal` / `Apply to
  Join`) linking via `tenantHref`.
- `(saas-member)/member/global-portal-home.tsx` — replace the plain
  "Your businesses" `<Card>` list with: fetch `listBusinessDirectory()` +
  existing `getMyTenantMemberships()` + existing `getMyVenueStatus()`, merge
  by `slug`, render `<LoungeDirectoryCard>` grid (`grid gap-6 sm:grid-cols-2
  lg:grid-cols-3`, per `.ai/rules/ui.md`'s dialog-grid spirit applied to a card
  grid). Keep the existing "Your account" card as-is (not in the reference
  screenshot's directory view, but no reason specified to remove it — confirm
  with developer only if this becomes contentious during audit).
- `(saas-member)/member/global-portal-layout.tsx` — replace the bare custom
  `<header>` with `<MarketingHeader actions={<signed-in IdentityMenu row>} />`
  + `<MarketingFooter year={...} />` wrapping `children`, matching the
  oikos precedent the developer confirmed (landing header/footer reused on
  the member page).
- `src/components/landing/marketing-chrome.tsx` — give `MarketingHeader` an
  optional `actions?: React.ReactNode` prop (default = existing
  ThemeToggle+CTA row, every current caller unaffected).

## Acceptance criteria

- Apex `/member` (post-rename) renders: `MarketingHeader` (signed-in identity
  menu instead of "Join Chrono" CTA) → sidebar + "Gaming Lounge Directory"
  heading + card grid of every active tenant → `MarketingFooter`.
- A tenant the customer has joined shows "Enter Portal"; every other active
  tenant shows "Apply to Join". Both link to `{slug}.appDomain/member`
  (no apex-side apply API call).
- A suspended/cancelled/archived tenant never appears in the grid.
- The directory list failing to load does not blank the page — the "Your
  account" card and (if present) membership data still render.
- No hardcoded color literals introduced; all new markup uses `agora/ui`
  primitives and semantic tokens.
- Every existing `MarketingHeader` caller (apex marketing pages) renders
  unchanged.

## E2E (required — cross-tenant, customer-facing feature)

New spec: `apps/chrono-web/e2e/tests/member/lounge-directory.spec.ts`
(rename note: adjust the folder if `member-player-route-rename`'s Phase 3
already moved `e2e/tests/portal/*` by the time this is implemented):
- Happy path: a signed-in global customer sees at least one "Apply to Join"
  card and, for a tenant they've joined, an "Enter Portal" card.
- Isolation: a suspended tenant (seeded suspended) never renders as a card.
- Clicking "Apply to Join" navigates to that tenant's own `/member` and its
  existing apply prompt is reachable (no dead link / 404).

## Out of scope

- Any change to `applyForTenantMembership()`, `agora/customer-auth`, or the
  tenant-side apply prompt — reused as-is.
- The `/discover` search route and its ranking/availability logic — untouched.
- Renaming or restyling `MemberSidebar`/`member-nav.tsx` (tenant-side) — this
  plan's sidebar is a new, apex-only component.
- Adding new theme presets or colors — `elegant-gold` already covers this.
- Any platform-admin/RBAC surface — this is entirely customer-facing.

## Verification commands

```
pnpm typecheck
pnpm --filter @agora/chrono-api build
pnpm --filter @agora/chrono-web build
pnpm --filter @agora/api rls:proof   # unaffected, cheap, run anyway
pnpm --filter @agora/chrono-web test:e2e -- member/lounge-directory.spec.ts
```

## Execution start point

Once the route-rename plan's Phase 1 (+ ideally Phase 2) is committed: add
`businessDirectoryListQuerySchema` + `BusinessDirectoryListItem` to
`apps/chrono-api/src/modules/business-lead/contracts.ts`.

## Phases (fill in during audit / before moving to `ready/`)

Suggested split, to be confirmed at audit:
1. Backend directory route + contracts.
2. Frontend data layer (`listBusinessDirectory`, shared `tenantHref`).
3. UI components (`MarketingHeader` `actions` prop, sidebar, card, page/layout
   assembly).
4. E2E spec.

This plan has **not** passed the Concreteness Gate for phase-by-phase
step-by-step tasks yet (only the file list + acceptance criteria are filled
in) — needs a pass-2 audit before `git mv` to `ready/`.
