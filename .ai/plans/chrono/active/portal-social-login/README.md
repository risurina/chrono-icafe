# Chrono: wire social login into the member portal pages

## Context

Companion plan to `.ai/plans/agora/active/member-portal-social-login/README.md`, which
builds the foundation OAuth capability (schema, routes, client helpers,
`MemberSocialSignIn` component). This plan is the Chrono-specific consumer: get
"Continue with Google" / "Continue with Facebook" onto Izur Gaming's actual login and
sign-up pages, matching the visual reference at `gaming.chrono.izur.com.ph/login`
(within the constraint that unavailable providers are hidden, not greyed — see the
foundation plan's Decision D4).

**This plan cannot start until the foundation plan's Phases 1–4 are done** — it depends
on the migrated `TenantMemberOAuthAccounts` table existing in `@agora/chrono-api`'s own
database (foundation Phase 1 explicitly migrates both apps) and on
`MemberSocialSignIn`/`memberAuth.providers()`/`memberAuth.oauthStartUrl()` being
exported from `agora/ui` / `agora/client`.

**Corrected route target** (fixes the first draft's Blocker 6): the tenant-host member
login page is `/login`, **not** `/portal/login` —
`apps/chrono-web/src/app/(member-portal)/portal/login/page.tsx` is now a redirect stub
(`if (tenant) window.location.replace("/login")`) for the apex-only global-customer
flow; the actual tenant member form lives at
`apps/chrono-web/src/app/(member-portal)/login/page.tsx`, which renders
`TenantLoginForm` from `../portal/login/tenant-login-form.tsx`. Sign-up did not move:
`apps/chrono-web/src/app/(member-portal)/portal/sign-up/page.tsx` still renders
`TenantSignUpForm` directly on a tenant host.

## Phase 5 — Wire into the login and sign-up forms

**Files**:
- `apps/chrono-web/src/app/(member-portal)/portal/login/tenant-login-form.tsx` (shared
  by both the `/login` route and legacy `/portal/login` redirect target — one edit
  covers both).
- `apps/chrono-web/src/app/(member-portal)/portal/sign-up/tenant-signup-form.tsx` (or
  the actual filename in that directory — confirm exact name before editing).
- `apps/chrono-web/src/app/(member-portal)/login/page.tsx` — read `?error=` here
  (this is the route that actually renders on a tenant host).

**Step-by-step**:
1. In `TenantLoginForm` and the sign-up form: fetch `memberAuth.providers()` on mount
   (follow whichever data-fetch pattern the form already uses — plain `useEffect` +
   `useState`, or an existing SWR/query hook if the file already has one; do not
   introduce a new fetching pattern into a file that already has one).
2. Render `<MemberSocialSignIn providers={providers} tenantSlug={tenantSlug}
   next={...} />` (from `agora/ui`) above an "OR" divider, above the existing
   email/password fields — matching the reference screenshot's order. Only render the
   divider when `providers.social.length > 0` (an all-hidden state, per D4, must not
   leave an orphaned "OR" with nothing above it).
3. In `apps/chrono-web/src/app/(member-portal)/login/page.tsx`: read `?error=` via
   `useSearchParams()`, and where present, call `toast.error(describeMemberAuthError(
   code))` (the foundation plan's Phase 4 helper) once on mount. Repeat the same
   `?error=` handling in the sign-up page, since the OAuth callback can land a new
   member there too (Google/Facebook "sign up" and "sign in" are the same callback —
   Phase 3 of the foundation plan already creates-or-matches).
4. `tenantSlug` for `oauthStartUrl(...)` comes from whatever the form already resolves
   the tenant from (host or a prop already threaded through — confirm the existing
   pattern in `tenant-login-form.tsx` before adding a new lookup).

**Acceptance criteria**: buttons render only for providers `memberAuth.providers()`
reports available; clicking "Continue with Google/Facebook" performs a full-page
navigation to the foundation's `/portal/auth/google/start?tenant=...` (not a fetch
call); a returned `?error=` renders a toast with the mapped copy and does not leave a
blank/broken form state; the existing email/password path is unchanged.

**Verification commands**: `pnpm --filter @agora/chrono-web typecheck`; manual walk
via `pnpm dev` — hit `/login` and `/portal/sign-up` on a `*.localtest.me:3000` tenant
host with `GOOGLE_AUTH_KEY`/`SECRET` and `FACEBOOK_AUTH_KEY`/`SECRET` set to real test
OAuth app credentials, complete a real Google sign-in, confirm landing on `/portal`
with a session cookie and a new `TenantMembers` row.

**Out of scope**: the apex-only global-customer login form (`GlobalLoginForm`) — this
plan is tenant-member-portal only; any redesign of the existing email/password layout
beyond adding the social buttons above it.

**Execution start point**: read
`apps/chrono-web/src/app/(member-portal)/portal/login/tenant-login-form.tsx` in full
to confirm its current data-fetch/state pattern before adding `providers()`.

## Phase 6 — E2E

**Files**: `apps/chrono-api/src/e2e/run.ts` (extend — the enforced, in-process PGlite
gate; this is where the real flow-correctness proof runs, per
`.ai/rules/e2e-testing.md` and the existing precedent documented in
`apps/chrono-web/e2e/tests/auth/social-providers.spec.ts`'s own header, which states
plainly that the Playwright suite cannot reach a real IdP consent screen);
`apps/chrono-web/e2e/tests/portal/social-login-ui.spec.ts` (new — the
`apps/chrono-web/e2e/tests/portal/` folder already exists, e.g.
`customer-onboarding.spec.ts`, so this is a sibling file, not a new top-level folder).

This splits Playwright-reachable behavior from IdP-round-trip behavior, per the
foundation plan's Phase 4 step 5, which already builds the stubbed-`fetch` harness
this phase's `run.ts` additions extend with Chrono-specific tenant fixtures.

**Step-by-step**:
1. `run.ts`: add Chrono tenant fixtures exercising the foundation's OAuth routes
   directly (in-process, stubbed IdP `fetch`) for the cases already enumerated in the
   foundation plan (create/reuse/cross-tenant/refuse-link/suspended/unavailable/
   missing-email) — reuse Chrono's existing tenant-seeding helpers in this file rather
   than writing new ones.
2. `social-login-ui.spec.ts` (Playwright, browser-level only — no real IdP hop):
   - Buttons render for available providers per `/portal/auth/providers`, and are
     absent (not disabled) for unavailable ones (D4).
   - Visiting `/login?error=account_not_linked` (and the other error codes) renders
     the corresponding toast copy.
   - Clicking "Continue with Google" triggers a full-page navigation to
     `/portal/auth/google/start?tenant=...` (assert on the navigation target, not on
     completing the flow — matching the existing `social-providers.spec.ts`
     precedent of stopping at the IdP boundary).

**Acceptance criteria**: `run.ts` fails if any of the foundation's callback branches
(link/create/refuse/suspend) regresses; the Playwright spec fails if a button renders
for an unavailable provider or an error code goes unmapped.

**Verification commands**: `pnpm --filter @agora/chrono-api test:e2e`;
`pnpm --filter @agora/chrono-api rls:proof` (re-confirms the Phase 1 migration from
the foundation plan is live in this app's database); the new Playwright spec, run per
`.ai/rules/e2e-testing.md`'s manual-suite instructions (`pnpm dev` first).

**Out of scope**: load/rate-limit testing of the OAuth endpoints; testing against a
real Google/Facebook sandbox app in CI (that stays a manual pre-release check, same as
the existing staff-pool social login).

**Execution start point**: read `apps/chrono-api/src/e2e/run.ts` in full to find the
existing tenant-member fixture/seeding pattern to extend.

## Plan closure

Once both this plan and the foundation plan are fully implemented and verified, move
both from `active/` to `archive/` in the same session, and update this README's status
line to point at the archived path.
