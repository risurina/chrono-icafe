# Plan — Unify `/portal` as a Single Host-Aware Route

Status: **Implemented** (2026-09-03) — both phases complete on branch
`unified-customer-portal`. Handoff notes:
- Phase 1 commit `ac78a15`, Phase 2 commit `5c061da`.
- Verification run: `pnpm typecheck` (whole workspace, via `pnpm --filter agora typecheck`)
  and `pnpm --filter @agora/chrono-web build` both pass; a route-level smoke check
  (`curl` against `/portal`, `/portal/login`, `/portal/sign-up`) returned 200 pre-cutover.
  Full interactive browser verification (confirming the apex vs. tenant-host branch
  renders the right content, and the Playwright e2e spec) was not run in this pass —
  flagged as a known gap, not claimed as done.
- Known pre-existing issue surfaced, not fixed here (out of scope): `apply-for-tenant.spec.ts`
  asserts a `"Join this workspace"` heading that doesn't match the actual copy
  (`"Join this business"`) — this mismatch predates this plan.
- Next: `.ai/plans/chrono/active/page-route-groups/README.md` can now proceed — `customer/`
  no longer exists as a separate folder.

Status (original): **Draft** (not yet accepted — do not implement)
App: `chrono` (business app), with one incidental one-line fix in the foundation
(`packages/agora/src/customer-auth`) — see "A note on app scope" below.
Type: behavior change (auth/session UX), reusing existing foundation primitives —
no new schema, no new RLS policy, no new permission, no new foundation auth module.

Depends on / interacts with: `.ai/plans/chrono/active/page-route-groups/README.md`
(the top-level route-group reorg). **This plan should land first**, while `/customer`
and `/portal` are still flat top-level folders — it's simpler to reason about the merge
before adding route-group parens on top, and it removes churn from the reorg plan
(which currently lists `/customer/*` as a folder to move; after this plan, that folder
no longer exists). The reorg plan has been updated to drop the `/customer` line and
note this dependency.

## Motivation

The developer wants a customer to be able to:
1. Sign in and view their account at the **SaaS main domain** level (today: `/customer`,
   a platform-wide identity — `agora/customer-auth`).
2. Sign in and view their account at the **tenant subdomain** and **tenant custom
   domain** level (today: `/portal`, tenant-scoped — `agora/member-auth`), seeing
   **only the data linked to that tenant**.
3. A customer who registers **directly at a tenant's subdomain/custom domain** stays
   scoped to that domain only — no forced "upgrade" to a global account (explicit
   requirement from the developer: "if the member is register in tenant level, they
   will stay in that domain/custom domain").

Points 2 and 3 already work today, unchanged, via the foundation's existing global-
customer design (`.ai/plans/agora/archive/global-customers/README.md`): a tenant
subdomain and its verified custom domain already resolve to the identical tenant and
hit the identical `/portal` code path (`architecture.md`'s Domain Surfaces table), and
`/portal/sign-up` already creates a tenant-only `tenantMember` with no link to any
global identity — exactly the "stays in that domain" behavior asked for. **Nothing
changes for tenant-only signups in this plan.**

What's missing is point 1 as the *same URL*: today it's a separate path (`/customer`),
not `/portal`. This plan makes `/portal` itself host-aware — one URL, two renderings,
chosen by which kind of host resolved the request — and retires `/customer` once
`/portal` fully covers what it did.

**Prior-art check**: `C:\Users\ronni\project\izur\oikos\apps\chrono-web\src\app\member\layout.tsx`
(the prior, non-Agora implementation named in `apps/chrono-api/AGENTS.md` as "prior art,
not a spec") already independently arrived at this exact shape — a single `member/`
route whose layout calls a host-resolution helper and branches between a tenant view and
a platform-wide "choose your business" view. This plan reuses the *idea* (one route,
resolved by host) but not oikos's implementation: oikos rewrites via patterns not
available here, and this repo's own `.ai/rules/architecture.md` prohibits Next.js
middleware outright. This plan uses a helper already in **this** foundation instead
(`isTenantHost()`, `agora/client`) called directly in each client component — no
middleware, no rewrite, matching how `stations/page.tsx` and `q/[token]/page.tsx`
already do host-aware rendering elsewhere in this same app.

## Pass 1 — Workflow Analysis

- **Who uses this:** end customers only. Tenant staff (dashboard) and platform admins
  are unaffected — this plan touches only `/portal/*` and the now-retired `/customer/*`.
- **Workflows enabled:**
  - A customer visits the SaaS main domain's `/portal`, signs up/in once (global
    identity), and sees their own profile — the same content `/customer` shows today.
  - A customer visits a tenant's subdomain or custom domain `/portal`: if they're a
    tenant-only customer or already linked (via Apply) to this tenant, they see exactly
    that tenant's data, unchanged from today. If they're signed in globally but not yet
    linked to *this* tenant, they see today's existing "Apply" prompt, unchanged.
  - A customer visits a tenant's subdomain/custom-domain `/portal/sign-up` directly:
    creates a tenant-only account, scoped to that domain only — unchanged from today.
- **Failure cases:**
  - A tenant-only customer (no global `customer` row) visiting the apex `/portal` sees
    the global sign-in form and has no account there — expected: they have never had a
    global identity, so this is not a regression, just an unchanged limitation of the
    two-pool design (`.ai/rules/business-app.md`, "Global customers").
  - `isTenantHost()` cannot be resolved until the component mounts in the browser
    (it reads `window.location.host`), so every route in scope shows a brief
    `Loading…` state before picking a branch — see "Loading-state note" below.
  - `/portal/accept-invite` and `/portal/inquiries` (tenant-only features, no global
    counterpart) are not given a global branch — see "Out of scope" below for the
    accepted edge case.
- **No tenant-isolation, RLS, or permission impact** — this plan renders existing
  session state two different ways; it does not change what `withTenant`/RLS/
  `getMemberContext()`'s bridge return.

### A note on app scope

This plan is filed under `chrono` because nearly all of it is `apps/chrono-web` page
work. One line in `packages/agora/src/customer-auth/index.ts` (the password-reset email
URL builder) is also touched — it hardcodes the page path `/customer/reset`, which must
track the page's new home. This is a literal path-string constant, not a foundation
architecture change, so it's included here rather than split into a companion `agora`
plan; flagged explicitly so it isn't missed.

## Pass 2 — Technical Planning

### The mechanism

`agora/client` already exports `isTenantHost(host, appDomain?)`
(`packages/agora/src/client/index.ts:99`): `host !== appDomain && host !== www.appDomain`.
This is `true` for **both** a tenant subdomain and a verified custom domain (neither
equals the apex or `www.`+apex), and `false` only for the literal apex — exactly the
"SaaS main domain vs. either kind of tenant host" boolean this plan needs, with zero new
foundation code.

Because `window.location.host` isn't known during server-side rendering inside a
`"use client"` component (and `headers()` — the server-side equivalent already used by
`getRequestTenant()` in `stations/page.tsx` — isn't callable from a client component),
each route resolves the branch **after mount**, via a `useState<boolean | null>` +
`useEffect(() => setIsTenant(isTenantHost(window.location.host)), [])`, matching the
loading-gate style these files already use for session state (e.g. today's
`portal/layout.tsx` already renders `<CenteredMessage>Loading…</CenteredMessage>` while
session hooks resolve).

**Rules-of-Hooks constraint that shapes the file layout:** the tenant branch and the
global branch each call a different, unconditional set of hooks (different session
hooks, different form state, `login`'s tenant branch alone uses `useSearchParams()` for
`?next=`). React forbids conditionally skipping hooks inside one component, so each
branch must be its **own component** — the route's `page.tsx`/`layout.tsx` becomes a
thin wrapper that resolves `isTenantHost()` and mounts exactly one of two sibling
components, never both.

### Files in scope

| Route | Thin wrapper (modified) | Tenant branch (new file, logic moved verbatim) | Global branch (new file, ported from `customer/*`) |
|---|---|---|---|
| `/portal` layout | `portal/layout.tsx` | `portal/tenant-portal-layout.tsx` ← today's `PortalLayout` body | `portal/global-portal-layout.tsx` ← `customer/layout.tsx`'s `CustomerLayout` body |
| `/portal` home | `portal/page.tsx` | `portal/tenant-portal-home.tsx` ← today's `PortalHome` body | `portal/global-portal-home.tsx` ← `customer/page.tsx`'s `CustomerHomePage` body |
| `/portal/login` | `portal/login/page.tsx` | `portal/login/tenant-login-form.tsx` ← today's `PortalLoginPage` | `portal/login/global-login-form.tsx` ← `customer/login/page.tsx`'s `CustomerLoginPage` |
| `/portal/sign-up` | `portal/sign-up/page.tsx` | `portal/sign-up/tenant-sign-up-form.tsx` ← today's `PortalSignUpPage` | `portal/sign-up/global-sign-up-form.tsx` ← `customer/sign-up/page.tsx`'s `CustomerSignUpPage` |
| `/portal/forgot` | `portal/forgot/page.tsx` | `portal/forgot/tenant-forgot-form.tsx` ← today's `PortalForgotPage` | `portal/forgot/global-forgot-form.tsx` ← `customer/forgot/page.tsx`'s `CustomerForgotPage` |
| `/portal/reset` | `portal/reset/page.tsx` | `portal/reset/tenant-reset-form.tsx` ← today's `PortalResetPage` | `portal/reset/global-reset-form.tsx` ← `customer/reset/page.tsx`'s `CustomerResetPage` |

Deleted once the above lands (Phase 2): `apps/chrono-web/src/app/customer/` (all 6
files: `layout.tsx`, `page.tsx`, `login/page.tsx`, `sign-up/page.tsx`,
`forgot/page.tsx`, `reset/page.tsx`).

Also touched: `packages/agora/src/customer-auth/index.ts` (one-line URL fix),
`apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts` (path/URL
updates, no new test cases).

### The thin-wrapper template (identical shape, 6 places)

```tsx
"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { TenantXxx } from "./tenant-xxx";
import { GlobalXxx } from "./global-xxx";

export default function XxxPage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? <TenantXxx /> : <GlobalXxx />;
}
```

The `layout.tsx` wrapper is the same shape but threads `children`:

```tsx
return isTenant ? (
  <TenantPortalLayout>{children}</TenantPortalLayout>
) : (
  <GlobalPortalLayout>{children}</GlobalPortalLayout>
);
```

### Content changes inside each ported "global" file (beyond the rename)

Every internal link/redirect in the ported global files currently points at
`/customer/*` and must be repointed at the shared `/portal/*` path — which, after the
merge, is the **same literal string** the tenant branch already uses (both branches
share one URL namespace now):

- `global-portal-layout.tsx` (from `customer/layout.tsx`): `PUBLIC` array becomes
  `["/portal/login", "/portal/sign-up", "/portal/forgot", "/portal/reset"]` (identical
  to the tenant branch's own `PUBLIC` array — no divergence); both `location.href =
  "/customer/login"` redirects become `/portal/login`.
- `global-login-form.tsx` (from `customer/login/page.tsx`): `location.href =
  "/customer"` → `/portal`; the two `<Link>`s to `/customer/forgot`/`/customer/sign-up`
  → `/portal/forgot`/`/portal/sign-up`.
- `global-sign-up-form.tsx` (from `customer/sign-up/page.tsx`): `location.href =
  "/customer"` → `/portal`; `<Link>` to `/customer/login` → `/portal/login`.
- `global-forgot-form.tsx` (from `customer/forgot/page.tsx`): `<Link>` to
  `/customer/login` → `/portal/login`.
- `global-reset-form.tsx` (from `customer/reset/page.tsx`): `window.location.href =
  "/customer/login"` → `/portal/login`; `<Link>` to `/customer/login` → `/portal/login`.
- `global-portal-home.tsx` (from `customer/page.tsx`): no internal links to change; its
  doc comment ("visit that business's `/portal`... see .../portal/layout.tsx") stays
  accurate as-is.

No other content changes — copy text (e.g. "Sign in" vs "Customer sign in", the
presence/absence of `<TenantBrandHeader />`) stays exactly as each source file has it
today; this plan does not redesign either form's look, only relocates and rewires them.

### Out of scope

- `/portal/accept-invite` and `/portal/inquiries` (tenant-only, no global counterpart)
  get no branch — visiting either on the apex host while signed in as a global customer
  renders inside `GlobalPortalLayout`'s chrome but the page's own tenant-scoped calls
  have no tenant to resolve. No link anywhere points there from the apex surface today,
  so this is an accepted, pre-existing-shaped edge case, not hardened further here. File
  a follow-up if a real navigation path to it ever appears.
- A "list of businesses you're a member of" or "browse tenants to apply to" view on the
  global home page (the closest analog in oikos's prior art). Not asked for; the ported
  `global-portal-home.tsx` keeps today's `/customer` content (name/email profile card)
  unchanged. Worth a separate, explicitly-scoped follow-up if wanted.
- Any redirect from the old `/customer/*` paths for bookmarked links or in-flight
  password-reset emails. Chrono has no real customers yet (`apps/chrono-api/AGENTS.md`,
  "Status: Migrating... started 2026-09-01"), so this plan treats the old path as safe
  to remove outright rather than adding temporary redirect shims. Flag if this
  assumption is wrong by the time this is implemented.
- Any change to `agora/customer-auth`'s or `agora/member-auth`'s session/bridge logic,
  `getMemberContext()`, or the `/portal/customer/apply` API route — all unchanged.
- Porting this pattern back to `apps/agora-web` — the scaffold has no `/customer`
  reference pages to merge (confirmed absent), so there is nothing to unify there today.

### Risk notes

- The Rules-of-Hooks-driven file split (12 new small files + 6 thin wrappers) is
  entirely mechanical once the mapping table above is fixed — a strong Jules candidate,
  same reasoning as the `page-route-groups` plan, but note this phase is NOT a pure
  file move (it edits redirect targets inside the moved code), so specify the exact
  string replacements above verbatim in the delegation prompt if delegated.
- Phase 1 is purely additive (`/customer/*` keeps working unchanged throughout), so it
  can be verified in isolation before Phase 2 deletes anything.

---

## Phase 1 — Make `/portal` host-aware (additive)

**Files to update**

New (tenant branch — move existing logic verbatim, rename the component, no behavior
change):
- `apps/chrono-web/src/app/portal/tenant-portal-layout.tsx`
- `apps/chrono-web/src/app/portal/tenant-portal-home.tsx`
- `apps/chrono-web/src/app/portal/login/tenant-login-form.tsx`
- `apps/chrono-web/src/app/portal/sign-up/tenant-sign-up-form.tsx`
- `apps/chrono-web/src/app/portal/forgot/tenant-forgot-form.tsx`
- `apps/chrono-web/src/app/portal/reset/tenant-reset-form.tsx`

New (global branch — port from `customer/*`, apply the link rewrites listed above):
- `apps/chrono-web/src/app/portal/global-portal-layout.tsx`
- `apps/chrono-web/src/app/portal/global-portal-home.tsx`
- `apps/chrono-web/src/app/portal/login/global-login-form.tsx`
- `apps/chrono-web/src/app/portal/sign-up/global-sign-up-form.tsx`
- `apps/chrono-web/src/app/portal/forgot/global-forgot-form.tsx`
- `apps/chrono-web/src/app/portal/reset/global-reset-form.tsx`

Modified (replaced with the thin-wrapper template):
- `apps/chrono-web/src/app/portal/layout.tsx`
- `apps/chrono-web/src/app/portal/page.tsx`
- `apps/chrono-web/src/app/portal/login/page.tsx`
- `apps/chrono-web/src/app/portal/sign-up/page.tsx`
- `apps/chrono-web/src/app/portal/forgot/page.tsx`
- `apps/chrono-web/src/app/portal/reset/page.tsx`

Untouched in this phase: `apps/chrono-web/src/app/customer/*` (still live, still
reachable, kept as a working fallback until Phase 2).

**Step-by-step tasks**

1. For each of the 6 routes, copy the existing page/layout's function body verbatim
   into the new `tenant-*.tsx` file, renaming the exported component per the mapping
   table (e.g. `PortalLoginPage` → `TenantLoginForm`). No logic changes.
2. For each of the 6 routes, copy the corresponding `customer/*` file's function body
   into the new `global-*.tsx` file, renaming the exported component per the mapping
   table, and apply exactly the link rewrites listed in "Content changes inside each
   ported global file" above.
3. Replace each of the 6 original `page.tsx`/`layout.tsx` files with the thin-wrapper
   template, importing its two new sibling components.
4. `pnpm --filter @agora/chrono-web build` and `pnpm typecheck`.
5. Manual walkthrough with `pnpm dev`:
   - Apex: visit `/portal` while signed out → global sign-in form; sign up a new
     account → lands on `/portal` showing the global profile card; sign out via the
     header button → back to `/portal/login`; forgot/reset round trip.
   - Tenant subdomain (`{slug}.localtest.me:3000`): visit `/portal` and confirm the
     existing tenant member experience (wallet/credits/sessions/apply-prompt) is
     byte-for-byte unchanged from before this phase.
   - Confirm `/customer/*` still works unchanged (not yet removed).

**Acceptance criteria**

- Apex `/portal/*` renders what `/customer/*` renders today, content-identical, at the
  new URL.
- Tenant-host `/portal/*` behavior is pixel-for-pixel unchanged from before this phase.
- No hook-order warning in the browser console on either branch.
- `pnpm --filter @agora/chrono-web build` and `pnpm typecheck` pass.

**Verification commands**

- `pnpm --filter @agora/chrono-web build`
- `pnpm typecheck`
- Manual walkthrough per step 5.

**Out of scope**

- Deleting `/customer/*` (Phase 2).
- The foundation reset-URL fix and e2e spec update (Phase 2).

**Execution start point**

- `apps/chrono-web/src/app/portal/layout.tsx`, using `apps/chrono-web/src/app/customer/layout.tsx` as the source for the global branch.

**Jules-eligible:** only with the mapping table and link-rewrite list above embedded
verbatim in the prompt — the moves themselves are mechanical, but each ported file
needs the exact string replacements applied, so under-specifying this would leave real
judgment calls. With the tables above pasted in, it's fully pinned.

---

## Phase 2 — Cutover: retire `/customer/*`

**Files to update**

- Deleted: `apps/chrono-web/src/app/customer/` (all 6 files).
- Modified: `packages/agora/src/customer-auth/index.ts` — `customerResetUrl()`:
  `` `${scheme}://${appDomain}/customer/reset?token=...` `` →
  `` `${scheme}://${appDomain}/portal/reset?token=...` ``.
- Modified: `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts`:
  - `page.goto("/customer/sign-up")` → `page.goto("/portal/sign-up")`.
  - `page.waitForURL(/\/customer$/, ...)` → `page.waitForURL(/\/portal$/, ...)`
    (still unambiguous at that point in the test — the browser is on the apex host,
    not yet on a tenant subdomain).
  - The `expect(page.getByText("Welcome, Global Test Customer"))` assertion and every
    other assertion are unchanged — the ported `global-portal-home.tsx` renders
    identical copy.

**Step-by-step tasks**

1. Delete `apps/chrono-web/src/app/customer/`.
2. Apply the one-line fix in `packages/agora/src/customer-auth/index.ts`.
3. Apply the two path/URL edits in `apply-for-tenant.spec.ts` listed above.
4. Grep the repo for any remaining `/customer` page-path reference (excluding the
   unrelated API mount points `/auth/customer/*` and `/portal/customer/apply` in
   `apps/chrono-api/src/app.ts`, and `packages/agora/src/client/index.ts`'s comments
   describing those same API paths — none of these are Next.js page paths and none
   change). Expect zero remaining hits after Phases 1–2.
5. `pnpm --filter @agora/chrono-web build`, `pnpm typecheck`.
6. Run `apply-for-tenant.spec.ts` end to end (`pnpm --filter @agora/chrono-web test:e2e`
   or the project's Playwright invocation) — it now exercises the same global-customer
   journey through `/portal` instead of `/customer`.

**Acceptance criteria**

- `apps/chrono-web/src/app/customer/` no longer exists.
- `apply-for-tenant.spec.ts` passes unchanged in assertions, updated only in the two
  path references above.
- The reset-password email link generated by `agora/customer-auth` points at
  `/portal/reset`, and that page (apex branch) successfully consumes the token.
- `pnpm --filter @agora/chrono-web build` and `pnpm typecheck` pass.

**Verification commands**

- `pnpm --filter @agora/chrono-web build`
- `pnpm typecheck`
- `apply-for-tenant.spec.ts` (Playwright)
- Manual: trigger a global-customer password reset, confirm the emailed link
  (`console` email provider in dev — check the dev log/inbox per
  `.ai/rules/providers.md`'s email category) lands on `/portal/reset` and works.

**Out of scope**

- Any redirect shim for the removed `/customer/*` paths (see "Out of scope" in Pass 2).

**Execution start point**

- `apps/chrono-web/src/app/customer/` (delete), then `packages/agora/src/customer-auth/index.ts:61`.

**Jules-eligible:** yes — delete + two pinned one-line edits + two pinned spec edits,
zero open decisions.

---

## CRUD & Feedback Contract

Not applicable — no new entity or mutation. Every toast/error message is moved
verbatim from its source file; no new user-facing copy is introduced.

## Sequencing note

Phase 1 before Phase 2 (additive before destructive, so the new behavior is fully
verified while the old path still works as a fallback). This whole plan before
`.ai/plans/chrono/active/page-route-groups/README.md`'s Phase 1, per that plan's own
updated dependency note.
