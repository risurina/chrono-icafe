# Chrono — global portal social login

**Sessions:** Planning: social-login-oauth-domain-fix [4739f0]

## What this is

Wires the new global-customer OAuth capability (built in the companion foundation plan,
`.ai/plans/agora/draft/customer-portal-social-login/README.md` — **must land first**,
phases 1-6) into Chrono's apex-facing portal forms. Today `chrono2.izur.com.ph/portal/login`
and `/portal/sign-up` (the apex, platform-wide "global customer" pool) are email/password
only — no Google/Facebook buttons at all, unlike the tenant member portal
(`{slug}.chrono2.izur.com.ph/login`), which already has social login
(`.ai/plans/chrono/archive/portal-social-login/README.md` is the precedent for that
wiring and the template for this one).

## Pass 1 — Workflow Analysis

- **Who uses it:** a visitor on the apex Chrono portal who wants to sign in/up with Google
  or Facebook instead of a password.
- **Workflow:** click "Continue with Google" on `/portal/login` or `/portal/sign-up` →
  full-page redirect to `/auth/customer/google/start` → IdP consent → redirected back to
  `/portal` (or wherever `?next=` pointed), signed in.
- **Failure cases:** `?error=` codes (`cancelled`, `provider_error`, `email_required`,
  `account_not_linked`, `account_suspended`, `invalid_state`) must surface as a toast on
  whichever apex form the user lands back on, and the form must remain fully usable
  (password fallback) if providers fail to load or none are configured.

## Pass 2 — Technical Planning

- **Depends on** the foundation plan's Phases 1-6 being merged first (new
  `customer-auth` routes, client helper, schema). Do not start Phase 7 below until that
  plan's `pnpm typecheck` + e2e are green.
- **Files in scope:** `apps/chrono-web` only, plus one new foundation UI component (see
  Phase 7 — defaulting it to `packages/agora` for consistency with `MemberSocialSignIn`,
  which lives there rather than app-local).
- **No schema/RLS/permission changes** in this plan — pure UI wiring + tests + docs.
- **Checks:** `pnpm typecheck`; manual browser verification of both forms (this repo's UI
  rule: "test the golden path and edge cases in a browser before reporting complete");
  the two new/updated e2e suites.

---

## Phase 7 — `CustomerSocialSignIn` + wiring into the two apex forms

**Files to Update:**
- New: `packages/agora/src/presentation/ui/components/custom/customer-social-sign-in.tsx`
  — copy `packages/agora/src/presentation/ui/components/custom/member-social-sign-in.tsx`
  (114 lines) as the starting point, then: **remove** the `parseHost(...).kind !==
  "subdomain" → return null` gate entirely (this component only ever renders on the
  apex-only global forms, so no host check is needed); **remove** the passkey button
  block (customer-auth's passkey ceremony is a separate, already-shipped concern — leave
  it out of this component; if passkey support is wanted on these forms later, that's a
  follow-up, not part of this plan); keep the SSR guard, the `!providers ||
  providers.social.length === 0 → return null` gate, and the per-provider `Button` +
  `window.location.href = customerAuth.oauthStartUrl(provider, next)` full-page-redirect
  pattern identical to the original.
- New: a `useCustomerAuthProviders()` hook, mirroring `useMemberAuthProviders()`
  (`member-social-sign-in.tsx:14-28`) — calls `customerAuth.providers()` once on mount.
  Put it in the same new file as the component (matching where `useMemberAuthProviders`
  lives relative to `MemberSocialSignIn`).
- `apps/chrono-web/src/app/(member-portal)/portal/login/global-login-form.tsx` — add
  `const providers = useCustomerAuthProviders();`, render `<CustomerSocialSignIn
  providers={providers} next="/portal" />` above an "OR" `Separator` (rendered only when
  `providers.social.length > 0`, exactly matching `MemberLoginForm`'s existing pattern),
  above the existing email/password form. Read `?error=` from the query string on mount,
  map it through a new `describeCustomerAuthError()` helper (mirror
  `describeMemberAuthError`, same closed error-code set from the foundation plan's Phase
  3), surface via `toast.error(...)`.
- `apps/chrono-web/src/app/(member-portal)/portal/sign-up/global-sign-up-form.tsx` —
  identical wiring, `next="/portal"` (or whatever this form already redirects to on
  success — check its current `location.href = "/portal"` line and match it).
- `describeCustomerAuthError()` — add wherever `describeMemberAuthError` currently lives
  (likely `apps/chrono-web/src/lib/` alongside `customer-client.ts`, or check where
  member's version lives and mirror the location) — maps each `CustomerOAuthErrorCode` to
  a user-facing message, one-for-one with `describeMemberAuthError`'s existing copy where
  the meaning is identical (`cancelled`, `provider_error`, `email_required`,
  `account_not_linked`, `account_suspended`, `invalid_state`).

**Acceptance Criteria:**
- Both apex forms render "Continue with Google"/"Continue with Facebook" buttons when
  both are configured (dev env: check whichever is actually configured locally — Facebook
  is deliberately left unconfigured in most dev setups, matching the existing member
  portal's own e2e assumptions).
- Clicking a button navigates to `/auth/customer/<provider>/start` (no `?tenant=` param,
  unlike the member-portal version).
- A `?error=<code>` on page load surfaces the mapped toast, and the form underneath
  remains fully interactive (password fields not disabled).
- If `customerAuth.providers()` fails/returns empty social list, no button renders, no
  crash, no "OR" divider — password form works standalone (fail-open, matching
  `memberAuth.providers()`'s own contract).

**Verification Commands:** `pnpm typecheck`; then manually: `pnpm --filter @agora/chrono-web dev`
(with `pnpm --filter @agora/chrono-api dev` running), visit
`http://chrono2.localtest.me:3000/portal/login` and `/portal/sign-up`, confirm buttons
render/navigate correctly, and confirm the tenant-subdomain forms (`{slug}.chrono2.localtest.me:3000/login`)
are visually unchanged (regression check — this phase must not touch `MemberSocialSignIn`
or its call sites).

**Out-of-Scope:** passkey UI on these forms; any change to `MemberSocialSignIn` itself or
its two existing call sites (`member-login-form.tsx`, `tenant-sign-up-form.tsx`).

**Execution Start Point:** Read `member-social-sign-in.tsx` in full, then
`apps/chrono-web/src/components/member-login-form.tsx` (127 lines) and
`apps/chrono-web/src/app/(member-portal)/portal/sign-up/tenant-sign-up-form.tsx` (123
lines) as the exact wiring precedent, then the two target files
(`global-login-form.tsx`, `global-sign-up-form.tsx`) before editing either.

---

## Phase 8 — Chrono e2e re-run + browser spec

**Files to Add/Update:**
- `apps/chrono-api/src/e2e/run.ts` — add a block re-running the foundation's
  `customer-oauth.test.ts` case list (from the companion plan's Phase 6) against Chrono's
  own schema/fixtures, mirroring the existing member-oauth re-run block's shape/reasoning
  (dedicated disposable fixtures, not shared `acmeId`/`contosoId`, to avoid file-ordering
  dependence with earlier destructive tests in the same run file — grep the existing
  member-oauth re-run block in this file for the exact fixture-naming convention to copy).
- New: `apps/chrono-web/e2e/tests/portal/global-social-login-ui.spec.ts` — same UI-only
  scope as the existing `apps/chrono-web/e2e/tests/portal/social-login-ui.spec.ts` (144
  lines: buttons hidden when genuinely unconfigured, buttons render when stubbed
  available via `page.route()` interception of `/auth/customer/providers`, clicking
  navigates to the right `/start` URL with stubbing to avoid hitting a real IdP, `?error=`
  codes render the right toast on both `/portal/login` and `/portal/sign-up`) — copy its
  structure against the apex host instead of a tenant subdomain.

**Acceptance Criteria:** both pass; the existing `social-login-ui.spec.ts` (tenant portal)
still passes unmodified — no regression.

**Verification Commands:**
```
pnpm --filter @agora/chrono-api <e2e script — check package.json for exact name>
pnpm dev   # required first, per .ai/rules/rbac.md's note on this Playwright config (headed, no webServer)
npx playwright test apps/chrono-web/e2e/tests/portal/global-social-login-ui.spec.ts
npx playwright test apps/chrono-web/e2e/tests/portal/social-login-ui.spec.ts   # regression check
```

**Execution Start Point:** Read `apps/chrono-api/src/e2e/run.ts`'s existing member-oauth
re-run block and `apps/chrono-web/e2e/tests/portal/social-login-ui.spec.ts` in full before
writing either new piece.

---

## Phase 9 — Env docs (developer action, not code)

**Files to Update:** `apps/chrono-api/.env.example` — extend the existing "Social
sign-in" comment block (currently documents the staff and member-portal callback URIs) to
also list:
```
# Global customer portal: http://api.localtest.me:8787/auth/customer/google/callback
# Global customer portal: http://api.localtest.me:8787/auth/customer/facebook/callback
```

**Task (developer, outside Claude Code):** register these two redirect URIs in the same
Google Cloud Console / Facebook Developer app already used for staff + member-portal — no
new OAuth client, no new env vars (confirmed decision from planning).

**Acceptance Criteria:** doc comment updated and committed; developer confirms both
redirect URIs are registered before testing against real Google/Facebook accounts.

**Verification Commands:** none (doc-only + manual developer step).

---

## Verification Summary (all phases)

`pnpm typecheck` · manual browser check of both apex forms + regression check of both
tenant-subdomain forms (Phase 7) · new Chrono e2e re-run passes (Phase 8) · new + existing
Playwright specs both pass (Phase 8) · env doc updated (Phase 9).

## Out of Scope (whole plan)

- Everything in the companion foundation plan (schema, contracts, OAuth engine, routes,
  client helper, foundation e2e) — this plan only consumes it.
- Passkey UI on the redesigned forms.
- Any change to the tenant member-portal's existing social login UI/tests.
