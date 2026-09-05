# Chrono follow-up: auth-page header/footer chrome

Status: Approved 2026-09-05. Not started.

## Context

`.ai/plans/agora/archive/auth-page-header-footer/README.md` (implemented, archived)
built a shared `AuthPageChrome` primitive so every unauthenticated page gets a real
header/footer, branched apex-vs-tenant. It explicitly scoped itself to
`apps/agora-web` only and named a documented follow-up
(`.ai/plans/chrono/active/auth-page-header-footer/`) to apply the identical pattern to
Chrono — that follow-up was never created. This is it, prompted by
`gaming.localhost:3000/login` still having no header/footer.

**This is not a mechanical copy.** Chrono's auth routing genuinely diverges from
`apps/agora-web`'s in three ways the archived plan's design didn't anticipate,
discovered by reading the actual pages:

1. `(saas-landing)/login/page.tsx` is **dual-purpose and host-branching at the
   page level**: apex → `<StaffLoginForm/>` (staff, no tenant yet), tenant host →
   `<MemberLoginForm/>` (this business's own customer sign-in, per
   `apps/chrono-api/AGENTS.md`: *"`{slug}.APP_DOMAIN/login` — customer (member)
   sign-in"*). In `apps/agora-web`, `/login` is unconditionally staff. So the chrome
   `surface` for this one route must be **computed from `context.kind`**
   (`"staff"` on apex, `"portal"` on tenant), not fixed like every other route.
2. Chrono's tenant-host **staff** sign-in lives at a different physical route with
   no `apps/agora-web` equivalent: `/admin/login`, physically
   `(tenant-admin)/staff-login/page.tsx` (rewritten from the public `/admin/login`
   URL per `next.config.ts`, sitting outside the dashboard layout's session gate).
3. The canonical **tenant-host customer sign-in link is `/login` itself**, not
   `/portal/login` — confirmed by `staff-login/page.tsx:25`'s own
   `<StaffLoginForm customerLoginHref="/login" />`. `/portal/login` still exists
   but is the legacy/global-customer-compatible path foundation emails hardcode
   (`apps/chrono-api/AGENTS.md`), not what chrome links should point new visitors
   at.

`AuthPageChrome` (`packages/agora/src/presentation/ui/components/custom/auth-page-chrome.tsx`)
currently **hardcodes** `/login` and `/portal/login` as literal `Link href`s inside
its `staff`/`portal` × `apex`/`tenant` action matrix (lines 74, 88, 93, 108, 117).
That's correct for `apps/agora-web` but wrong for Chrono's tenant-host cells. Fix:
add two optional override props, each defaulting to today's literal (so
`apps/agora-web`'s existing call sites need zero changes):

```ts
staffLoginHref?: string;    // default "/login"
customerLoginHref?: string; // default "/portal/login"
```
used everywhere those two literals currently appear. Chrono's own wrapper
components compute the right value per `context.kind` and pass it down.

## Reuse — what's already built and needs no changes

- `resolveAuthChromeContext()` / `AuthChromeContext` / `getPublicTenant()`
  (`packages/agora/src/presentation/next/index.ts`) — generic, host-agnostic, reused as-is.
- `AuthLayout`'s `inset` prop (`packages/agora/src/presentation/ui/components/custom/auth-layout.tsx`) —
  already exists, defaults `false`, reused as-is.
- `AuthPageChrome` itself — reused, with the two new override props above (the
  only foundation code change this plan needs).
- `ChronoBrand` (`apps/chrono-web/src/components/landing/chrono-brand.tsx`) — the
  ready-made `apexBrand` equivalent (owl mark + wordmark), used exactly like
  `apps/agora-web`'s `ApexBrand`.

## Concrete page inventory (verified by reading each file)

| Route (public URL) | Physical file(s) | Surface | context.kind in practice | AuthLayout call site(s) needing `inset` |
|---|---|---|---|---|
| `/login` (apex) | `(saas-landing)/login/page.tsx` → `StaffLoginForm` | computed: `"staff"` | apex | `components/staff-login-form.tsx:93` |
| `/login` (tenant) | same file → `MemberLoginForm` | computed: `"portal"` | tenant | `components/member-login-form.tsx:61` |
| `/login/verify-mfa` | `(saas-landing)/login/verify-mfa/page.tsx` | inherits `/login`'s layout | apex in practice (2FA only follows staff sign-in) | `login/verify-mfa/page.tsx:45` |
| `/admin/login` (tenant only) | `(tenant-admin)/staff-login/page.tsx` → `StaffLoginForm` | fixed `"staff"` | tenant only (apex hits redirect away) | same `staff-login-form.tsx:93` (already covered above) |
| `/sign-up` | `(saas-landing)/sign-up/page.tsx` | fixed `"staff"` | apex | `sign-up/page.tsx:83` |
| `/forgot-password` | `(saas-landing)/forgot-password/page.tsx` | fixed `"staff"` | apex | `forgot-password/page.tsx:39` |
| `/reset-password` | `(saas-landing)/reset-password/page.tsx` | fixed `"staff"` | apex | `reset-password/page.tsx:53` |
| `/new-business` | `(saas-landing)/new-business/page.tsx` | fixed `"staff"` | apex | `new-business/page.tsx:121,145` (both branches, same as agora-web's `new-workspace`) |
| `/accept-invite` | `(tenant-landing)/accept-invite/page.tsx` | fixed `"staff"` | tenant | `accept-invite/page.tsx:90` |
| `/suspended` | `(tenant-landing)/suspended/page.tsx` | fixed `"staff"` | tenant | `suspended/page.tsx:20` |
| `/portal/login` | `(member-portal)/portal/login/page.tsx` → `global-login-form.tsx` | fixed `"portal"` | apex or tenant | `portal/login/global-login-form.tsx` |
| `/portal/sign-up` | `.../portal/sign-up/page.tsx` → global/tenant form | fixed `"portal"` | apex or tenant | `portal/sign-up/global-sign-up-form.tsx`, `tenant-sign-up-form.tsx` |
| `/portal/forgot` | `.../portal/forgot/page.tsx` → global/tenant form | fixed `"portal"` | apex or tenant | `portal/forgot/global-forgot-form.tsx`, `tenant-forgot-form.tsx` |
| `/portal/reset` | `.../portal/reset/page.tsx` → global/tenant form | fixed `"portal"` | apex or tenant | `portal/reset/global-reset-form.tsx`, `tenant-reset-form.tsx` |
| `/portal/accept-invite` | `.../portal/accept-invite/page.tsx` (direct) | fixed `"portal"` | tenant | `portal/accept-invite/page.tsx:52` |

`(saas-landing)/auth/callback/page.tsx` stays excluded, same reasoning as the
archived plan (bare `CenteredMessage`, not `AuthLayout`; sub-second machine
redirect).

`/portal/accept-invite` has **no `apps/agora-web` equivalent** — a genuinely new
cell this plan adds, not present in the original inventory.

## Phase 1 — Foundation: parameterize the two hardcoded hrefs

**Files to update:** `packages/agora/src/presentation/ui/components/custom/auth-page-chrome.tsx`.

**Step-by-step tasks:** add `staffLoginHref = "/login"` and
`customerLoginHref = "/portal/login"` as optional props with those defaults;
replace the 4 hardcoded literal occurrences (`/login` at lines 74, 93, 117
footer; `/portal/login` at line 88) with the prop values. No other prop, export,
or call-site signature changes.

**Acceptance criteria:** `apps/agora-web`'s existing call sites (which pass
neither prop) render byte-identical output — verified by diff, since they don't
pass these props at all.

**Verification commands:** `pnpm typecheck`.

**Out of scope:** any Chrono file.

**Execution start point:** `packages/agora/src/presentation/ui/components/custom/auth-page-chrome.tsx`.

## Phase 2 — Chrono app-local chrome wrappers

**Files to update (new):**
- `apps/chrono-web/src/lib/auth-chrome.ts` — re-exports
  `resolveAuthChromeContext`/`AuthChromeContext` from `agora/next`, matching
  `apps/agora-web`'s equivalent.
- `apps/chrono-web/src/components/staff-auth-chrome.tsx` — `surface="staff"`,
  always computes `staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}`
  (needed for the `/admin/login`/`/accept-invite`/`/suspended` tenant cells;
  harmless no-op on apex, where the "staff" surface's apex cell never reads
  `staffLoginHref` in the first place) and
  `customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"}`.
- `apps/chrono-web/src/components/portal-auth-chrome.tsx` — `surface="portal"`,
  same two computed props.
- `apps/chrono-web/src/app/(saas-landing)/login/layout.tsx` — the one bespoke
  layout: resolves `context` directly (not via the two wrappers above, since
  `surface` itself must be computed for this route), renders
  `<AuthPageChrome context={context} surface={context.kind === "apex" ? "staff" : "portal"} staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"} customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"} apexBrand={<ChronoBrand/>} apexProductName="Chrono">{children}</AuthPageChrome>`.
  Covers `login/page.tsx` **and** `login/verify-mfa/page.tsx` (nested, inherits
  automatically).

**Acceptance criteria:** the 3 new components compile; `pnpm typecheck` passes.

**Verification commands:** `pnpm typecheck`.

**Out of scope:** wiring any page/layout that consumes these (Phase 3/4).

**Execution start point:** `apps/chrono-web/src/lib/auth-chrome.ts`.

## Phase 3 — Wire the fixed-surface `(saas-landing)` + `(tenant-admin)` staff pages

**Files to update (new layout.tsx, each renders `<StaffAuthChrome>{children}</StaffAuthChrome>`):**
- `apps/chrono-web/src/app/(saas-landing)/sign-up/layout.tsx`
- `apps/chrono-web/src/app/(saas-landing)/forgot-password/layout.tsx`
- `apps/chrono-web/src/app/(saas-landing)/reset-password/layout.tsx`
- `apps/chrono-web/src/app/(saas-landing)/new-business/layout.tsx`
- `apps/chrono-web/src/app/(tenant-admin)/staff-login/layout.tsx`

**Files to update (edit — `<AuthLayout>` → `<AuthLayout inset>`):**
- `apps/chrono-web/src/components/staff-login-form.tsx:93` (covers both `/login`
  apex and `/admin/login` — one edit, two routes, since both pages render this
  same shared component)
- `apps/chrono-web/src/components/member-login-form.tsx:61` (covers `/login` tenant)
- `apps/chrono-web/src/app/(saas-landing)/sign-up/page.tsx:83`
- `apps/chrono-web/src/app/(saas-landing)/forgot-password/page.tsx:39`
- `apps/chrono-web/src/app/(saas-landing)/reset-password/page.tsx:53`
- `apps/chrono-web/src/app/(saas-landing)/new-business/page.tsx:121,145` (both
  branches)
- `apps/chrono-web/src/app/(saas-landing)/login/verify-mfa/page.tsx:45`

**Acceptance criteria:** `http://localhost:3000/login` (apex) shows the Chrono
apex header/footer; `http://localhost:3000/sign-up`, `/forgot-password`,
`/reset-password`, `/new-business` same; `http://gaming.localhost:3000/admin/login`
shows Chrono's tenant-branded header/footer with a **working** "Sign in"
(customer) link to `/login` — no self-referential dead link. Card stays
vertically centered, no page scrollbar.

**Verification commands:** `pnpm typecheck`; manual via `pnpm dev` at the URLs
above.

**Out of scope:** `(tenant-landing)` and `(member-portal)` pages (Phase 4).

**Execution start point:** `apps/chrono-web/src/components/staff-login-form.tsx`.

## Phase 4 — Wire `(tenant-landing)` + `(member-portal)` pages

**Files to update (new layout.tsx):**
- `apps/chrono-web/src/app/(tenant-landing)/accept-invite/layout.tsx` (renders
  `<StaffAuthChrome>`)
- `apps/chrono-web/src/app/(tenant-landing)/suspended/layout.tsx` (renders
  `<StaffAuthChrome>`)
- `apps/chrono-web/src/app/(member-portal)/portal/login/layout.tsx`
- `apps/chrono-web/src/app/(member-portal)/portal/sign-up/layout.tsx`
- `apps/chrono-web/src/app/(member-portal)/portal/forgot/layout.tsx`
- `apps/chrono-web/src/app/(member-portal)/portal/reset/layout.tsx`
- `apps/chrono-web/src/app/(member-portal)/portal/accept-invite/layout.tsx`
(all 5 portal ones render `<PortalAuthChrome>`)

**Files to update (edit — `<AuthLayout>` → `<AuthLayout inset>`):**
- `(tenant-landing)/accept-invite/page.tsx:90`, `suspended/page.tsx:20`
- `portal/login/global-login-form.tsx`
- `portal/sign-up/global-sign-up-form.tsx`, `tenant-sign-up-form.tsx`
- `portal/forgot/global-forgot-form.tsx`, `tenant-forgot-form.tsx`
- `portal/reset/global-reset-form.tsx`, `tenant-reset-form.tsx`
- `portal/accept-invite/page.tsx:52`

No edit needed to `(member-portal)/portal/global-portal-layout.tsx` — its
existing `PUBLIC` array already lists all 5 paths and returns `<>{children}</>`
for them (confirmed by reading the file), so the new per-route layouts compose
underneath it exactly like `apps/agora-web`'s equivalent passthrough.

**Acceptance criteria:** `gaming.localhost:3000/accept-invite`, `/suspended`,
`/portal/login`, `/portal/sign-up`, `/portal/forgot`, `/portal/reset`,
`/portal/accept-invite` all show the tenant header/footer with correct action
links (no link pointing at `/login` when tenant-host staff sign-in is really
`/admin/login`).

**Verification commands:** `pnpm typecheck`; manual via `pnpm dev`.

**Out of scope:** everything else.

**Execution start point:** `apps/chrono-web/src/app/(tenant-landing)/suspended/layout.tsx`.

## Phase 5 — Verification pass (e2e)

**Files to update (new):** `apps/chrono-web/e2e/tests/auth/header-footer.spec.ts`,
following the exact pattern the archived agora plan used
(`e2e/tests/auth/signup-onboarding.spec.ts`'s runtime-created workspace, absolute
`http://${slug}.localhost:3000/...` URLs for tenant cases).

**Step-by-step tasks / cases:**
1. Apex `/login` — header shows "Get started", footer shows "Chrono" copyright.
2. Tenant `/login` (member form) — header/footer show the tenant's brand, and
   the header's staff-sign-in-equivalent action (if shown) points at
   `/admin/login`, never back at `/login`.
3. Tenant `/admin/login` (staff form) — header shows the tenant brand, "Sign
   in" (customer) action points at `/login`.

**Acceptance criteria:** all 3 cases pass headed via the existing manual
Playwright setup.

**Verification commands:** `npx playwright test e2e/tests/auth/header-footer.spec.ts`.

**Out of scope:** none beyond the 3 cases above.

**Execution start point:** `apps/chrono-web/e2e/tests/auth/signup-onboarding.spec.ts`
(read for the exact sign-up-flow selectors/timing to reuse, if one exists —
otherwise `apps/chrono-web/e2e/tests/auth/`'s nearest equivalent).

## Out of scope (whole plan)

- Any change to `apps/agora-web` beyond the two new optional props (Phase 1) —
  its existing behavior is unchanged and unaffected.
- `auth/callback` — excluded, same reasoning as the archived plan.
- Redesigning `SiteHeader`/`SiteFooter`/`BrandHeader`/`StaffLoginForm`/
  `MemberLoginForm` themselves.
- The inner client-side `isTenantHost` branching already inside `/login`,
  `/portal/*` pages (which form renders) — unrelated to the outer chrome layer
  this plan adds; left exactly as-is.
- The `/stations` vs. landing-page-section link drift (a separate, already
  flagged item, not part of this plan).

## Verification (overall)

- `pnpm typecheck` after each phase.
- Manual `pnpm dev` checks at every URL named in each phase's acceptance
  criteria, apex and a real tenant subdomain.
- New e2e spec passes.

## Plan Closure

Move to `.ai/plans/chrono/archive/auth-page-header-footer/` once Phase 5 passes;
note in the closing commit that Chrono now shares the same `AuthPageChrome`
primitive as `apps/agora-web`, with the two href-override props as the one
foundation change needed to fit Chrono's differing route topology.
