# Chrono: wire social login into the member portal pages

## Context

Companion plan to `.ai/plans/agora/active/member-portal-social-login/README.md`, which
builds the foundation OAuth capability (schema, routes, client helpers,
`MemberSocialSignIn` component). This plan is the Chrono-specific consumer: get
"Continue with Google" / "Continue with Facebook" onto Izur Gaming's actual login and
sign-up pages, matching the visual reference at `gaming.chrono.izur.com.ph/login`
(within the constraint that unavailable providers are hidden, not greyed, and
verified-custom-domain tenants don't get the buttons in MVP — see the foundation
plan's Decisions D4/D6).

**This plan cannot start until the foundation plan's Phases 1–4 are done** — it depends
on the migrated `TenantMemberOAuthAccounts` table existing in `@agora/chrono-api`'s own
database, on both OAuth apps' redirect URIs being registered (foundation plan D1's new
task), and on `MemberSocialSignIn`/`memberAuth.providers()`/`memberAuth.oauthStartUrl()`
being exported from `agora/ui` / `agora/client`.

**Corrected file paths (this is a full rewrite of the first two drafts, which both
named files that don't exist in this tree — verified directly against the actual
`apps/chrono-web` source before writing this revision):**

| Wrong (earlier drafts) | Actual |
|---|---|
| `(member-portal)/login/page.tsx` | Does not exist. `/login` on a tenant host is `apps/chrono-web/src/app/(saas-landing)/login/page.tsx` — it branches `isTenantHost()` → `MemberLoginForm` : `StaffLoginForm`. **This file needs no change** in this plan (see Phase 5, step 3) — the `?error=` handler goes in the form component it renders, not the page, so the staff branch is never touched. |
| `(member-portal)/portal/login/tenant-login-form.tsx`, `TenantLoginForm` | Does not exist. The tenant member login form is `apps/chrono-web/src/components/member-login-form.tsx`, exporting `MemberLoginForm`. `(member-portal)/portal/login/` contains only `page.tsx` (an apex-only redirect stub for the legacy `/portal/login` URL, rendering `GlobalLoginForm` on apex / `window.location.replace("/login")` on a tenant host — no form is "shared" between the two routes) and `global-login-form.tsx`. |
| `portal/sign-up/tenant-signup-form.tsx` | `apps/chrono-web/src/app/(member-portal)/portal/sign-up/tenant-sign-up-form.tsx` (note the hyphen: `tenant-sign-up-form.tsx`), exporting `TenantSignUpForm`. |

## Phase 5 — Wire into the login and sign-up forms

**Files**:
- `apps/chrono-web/src/components/member-login-form.tsx` (`MemberLoginForm`) — this is
  the file that actually renders on `/login` for a tenant host. It already imports
  `useSearchParams` and `toast` from `agora/ui`, `safeNextPath` from `agora/client`,
  and imports `memberAuth` via `@/lib/member-client` (which re-exports from
  `agora/client`) — reuse all existing import points rather than adding new ones.
- `apps/chrono-web/src/app/(member-portal)/portal/sign-up/tenant-sign-up-form.tsx`
  (`TenantSignUpForm`) — **(3rd-pass fix, Condition A)** this file does **not**
  currently import `useSearchParams` (it imports only `useState`, `Link`, `agora/ui`
  primitives, `memberAuth`, `TenantBrandHeader`) — add
  `import { useSearchParams } from "next/navigation"` here.
- `apps/chrono-web/src/app/(saas-landing)/login/page.tsx` — read only, to confirm it
  passes no props that would need updating; no edit expected here (the toast/error
  handling lives inside `MemberLoginForm` itself, so the staff `StaffLoginForm` branch
  on the same page is unaffected).
- `apps/chrono-web/src/lib/member-client.ts` — **read only, no edit**. It re-exports
  `memberAuth`, `MemberUser`, `useMemberSession` only; `MemberSocialSignIn` and
  `describeMemberAuthError` are imported directly from `agora/ui` / `agora/client`
  respectively (Condition B), not funneled through this barrel.

**Step-by-step**:
1. In `MemberLoginForm` and `TenantSignUpForm`: fetch `memberAuth.providers()` on
   mount, via the existing `@/lib/member-client` import — follow whichever data-fetch
   pattern the file already uses (plain `useEffect` + `useState`, or an existing
   query hook if present; do not introduce a second fetching pattern into a file that
   already has one).
2. Import `MemberSocialSignIn` from `agora/ui` in both forms. Render
   `<MemberSocialSignIn providers={providers} next={next} />` above an "OR" divider,
   above the existing email/password fields — matching the reference screenshot's
   order. **(3rd-pass fix, Condition 6/E)** No `tenantSlug` prop: per the foundation
   plan's revised `MemberSocialSignIn` contract, the component derives the tenant
   slug itself via `parseHost(window.location.host, ...)` and renders nothing on an
   apex or custom-domain host — this plan's forms pass only `providers` and `next`.
   Pin `next`: `MemberLoginForm` passes `safeNextPath(searchParams.get("next")) ??
   "/portal"` (reusing the `safeNextPath` import it already has); `TenantSignUpForm`
   passes the literal `"/portal"` (it has no `next` query param concept today). Only
   render the "OR" divider when `providers.social.length > 0` (an all-hidden state
   must not leave an orphaned divider with nothing above it).
3. Import `describeMemberAuthError` from `agora/client` in both forms **(Condition
   B)** — `TenantSignUpForm` does not currently import from `agora/client` at all, so
   this is a new import statement there; `MemberLoginForm` already imports
   `safeNextPath` from the same module, so it's an added named import, not a new
   module. In `MemberLoginForm`: read `?error=` via the existing `useSearchParams()`
   import, and where present, call `toast.error(describeMemberAuthError(code))` once
   on mount. Repeat in `TenantSignUpForm` using its newly-added `useSearchParams()`
   (step above), since the OAuth callback can land a new member there too
   (Google/Facebook "sign up" and "sign in" are the same callback — the foundation
   plan's Phase 3 already creates-or-matches). Note for parity: an OAuth-created
   member lands on `/portal` with no `ChronoMemberProfiles` row, identical to the
   existing password sign-up path (`TenantSignUpForm` creates no profile either;
   profile creation is a separate authenticated `POST /portal/members/apply` —
   correcting the earlier draft's `/portal/member/apply` typo, verified against
   `apps/chrono-api/src/app.ts`'s `.route("/portal/members", memberPortalRoutes())`)
   — no new handling needed for this, just noted so it isn't mistaken for a bug
   during testing.

**Acceptance criteria**: buttons render only for providers `memberAuth.providers()`
reports available, and are absent (not rendered at all) on a custom-domain tenant host;
clicking "Continue with Google/Facebook" performs a full-page navigation to the
foundation's `/portal/auth/google/start?tenant=...` (not a fetch call); a returned
`?error=` renders a toast with the mapped copy and does not leave a blank/broken form
state; the existing email/password path and the staff `/login` branch are unchanged.

**Verification commands**: `pnpm --filter @agora/chrono-web typecheck`; a `pnpm dev`
walk against `*.localtest.me:3000` confirming the buttons render/hide correctly per
`memberAuth.providers()` and that clicking one navigates to the correct `/portal/
auth/:provider/start?tenant=...` URL (this much works in the local dev loop). **A
completed real Google/Facebook sign-in is a staging/production-only manual check**
(foundation plan D1's Risk-12 note: `api.localtest.me` is not guaranteed to be
accepted as an OAuth redirect host by either IdP) — this plan's dev-loop verification
does not include completing the IdP round trip; that is covered once in staging with
both redirect URIs registered (foundation plan D1's task), matching Phase 6's
out-of-scope note below.

**Out of scope**: the apex-only global-customer login form (`GlobalLoginForm`) and the
staff `StaffLoginForm` branch — this plan is tenant-member-portal only; any redesign of
the existing email/password layout beyond adding the social buttons above it;
verified-custom-domain tenant support (foundation plan D6).

**Execution start point**: read `apps/chrono-web/src/components/member-login-form.tsx`
in full to confirm its current data-fetch/state pattern before adding `providers()`.

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
foundation plan's Phase 4 step 5, which stubs the IdP via `globalThis.fetch`
interception (mirroring `apps/chrono-api/src/e2e/sigv4.test.ts`'s existing pattern) —
this phase's `run.ts` additions reuse that same interception approach with
Chrono-specific tenant fixtures, not a module-boundary mock.

**Deliberately re-runs the foundation's case list, not a duplicate to dedupe**: the
foundation plan's `apps/agora-api/src/e2e/member-oauth.test.ts` (its Phase 4 step 5)
proves the eight cases against `@agora/api`'s own database; this phase proves the
*identical* eight against `@agora/chrono-api`'s — a separate Postgres database with
its own Drizzle migration history (D2). Passing in one app's database is not evidence
it passes in the other's: `TenantMemberOAuthAccounts`' unique indexes, the RLS policy
generated for it, and Chrono's own tenant-seeding fixtures are all independently
capable of drifting from the foundation package's shape. This is the same reasoning
`.ai/rules/database.md`'s `rls:proof` requires per-app rather than once — a shared
package's guarantee is only real once each consuming app proves it locally. So: same
eight cases, same assertions, run twice, on purpose. Do not "simplify" this later by
removing one copy.

**Step-by-step**:
1. `run.ts`: add Chrono tenant fixtures exercising the foundation's OAuth routes
   directly (in-process, `globalThis.fetch` stubbed for the Google/Facebook token+
   graph hosts) for the same eight cases the foundation plan's `member-oauth.test.ts`
   covers (create/reuse/cross-tenant/refuse-link/suspended/unavailable/missing-email/
   cancelled) — reuse Chrono's existing tenant-seeding helpers in this file rather
   than writing new ones. **(3rd-pass fix, Condition C)** `/start` and `/callback` are
   redirect responses (302), unlike every existing `/portal/auth/*` assertion in this
   file (all JSON POSTs, via the existing `req()` helper, which uses `fetch`'s default
   `redirect: "follow"` and returns `{ status, body, setCookie }`). Add a dedicated
   `reqNoFollow()` variant that passes `redirect: "manual"` and additionally returns
   `location: res.headers.get("location")` — every OAuth assertion in this phase reads
   that header (`/start`'s 302 `Location` is the authorize URL to inspect; `/callback`'s
   302 `Location` is the final `portalPathUrl`/`apexPathUrl` destination). It must
   capture `Set-Cookie` off `/start`'s response to hand back as the request cookie on
   the simulated `/callback` call, and the `globalThis.fetch` stub for the IdP hosts
   must pass through unstubbed to the real `fetch` for the local `base` origin (the
   harness's own `reqNoFollow`/`req` calls are themselves `fetch` calls against the
   same global).
2. `social-login-ui.spec.ts` (Playwright, browser-level only — no real IdP hop):
   - Buttons render for available providers per `/portal/auth/providers`, and are
     absent (not disabled) for unavailable ones, and absent specifically on the
     `gaming` tenant's verified custom domain `chrono2.izur.com.ph` **(3rd-pass fix,
     Condition D — this fixture already exists, not a hypothetical)**, per
     `apps/chrono-api/src/seed.ts`'s existing `gaming` tenant seed. Note: because
     `gaming` has both a subdomain and this custom domain, the social buttons appear
     on `gaming.<APP_DOMAIN>/login` but are absent on `chrono2.izur.com.ph/login` —
     expected per D6, not a bug to flag during the manual walk.
   - Visiting `/login?error=account_not_linked` (and the other error codes, including
     `cancelled` and `provider_unavailable` — the foundation plan's 4th-pass fix
     gives `provider_unavailable` an actual producer on `/start`) renders the
     corresponding toast copy.
   - Clicking "Continue with Google" triggers a full-page navigation to
     `/portal/auth/google/start?tenant=...` (assert on the navigation target, not on
     completing the flow — matching the existing `social-providers.spec.ts`
     precedent of stopping at the IdP boundary).

**Acceptance criteria**: `run.ts` fails if any of the foundation's callback branches
(link/create/refuse/suspend) regresses; `tenant_member_email_uq` is provable in this
suite (`run.ts` already creates unique indexes in its PGlite instance via
`uniqueIndexDdls`); the Playwright spec fails if a button renders for an unavailable
provider or an error code goes unmapped.

**Verification commands**: `pnpm --filter @agora/chrono-api test:e2e`;
`pnpm --filter @agora/chrono-api rls:proof` (re-confirms the foundation plan's Phase 1
migration is live in this app's database); the new Playwright spec, run per
`.ai/rules/e2e-testing.md`'s manual-suite instructions (`pnpm dev` first).

**Out of scope**: load/rate-limit testing of the OAuth endpoints; completing a real
Google/Facebook consent round trip anywhere in this suite or in the `pnpm dev` loop —
that is a staging/production-only manual check per the foundation plan's Risk-12 note
(matches Phase 5's verification commands above), same scope as the existing
staff-pool social login's own manual verification.

**Execution start point**: read `apps/chrono-api/src/e2e/run.ts` in full to find the
existing tenant-member fixture/seeding pattern and `sigv4.test.ts`'s `globalThis.fetch`
interception pattern to combine.

## Plan closure

Once both this plan and the foundation plan are fully implemented and verified, move
both from `active/` to `archive/` in the same session, and update this README's status
line to point at the archived path. Both plans must be committed to `main` before
implementation starts, per `.ai/rules/feature-planning.md`.
