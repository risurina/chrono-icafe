# Member / Player route rename — `(saas-member)/member` + `(tenant-member)/player`

**Status:** draft — awaiting developer acceptance (and a decision on the Open Decision below)
**App:** chrono
**Sessions:**
- Planning: agora-a3 [4c723d]
- Audit: agora-a3 [4c723d]
- Implementation: _unclaimed_

## Goal

Rename the two Chrono member route trees so the folder names read the way the
product talks, and serve `/member` on **both** hosts:

| Host | URL | Physical tree |
|---|---|---|
| apex (`chrono2.izur.com.ph`) | `/member/*` | `(saas-member)/member` |
| tenant (`isurina.chrono2.izur.com.ph`) | `/member/*` | `(tenant-member)/player` (via host-conditioned rewrite) |

`player` is already Chrono's user-facing word for a tenant member — the whole
tenant-admin surface says "Players" (`dashboard/members/page.tsx:317,323,350`,
`dashboard/growth/page.tsx:72-94`), and `(saas-admin)/admin/global-customers/page.tsx:44`
annotates `/admin/members ("Players")`.

## Why this needs a plan (and why the last two attempts were reverted)

Next's App Router builds its route table from the filesystem at compile time and
keys purely on pathname — route groups `(...)` are stripped from the URL and
there is no host dimension. So two folders that both flatten to `/member` are a
build-time duplicate. That is the "two parallel pages resolve to the same path"
Turbopack error recorded in `8fde2bce`'s revert message; `a07ff5fd` → `e7840131`
is the second attempt/revert cycle. **This plan's whole job is to not repeat
that**: exactly one physical tree may own `/member`, and the other reaches that
URL through a rewrite.

That rewrite pattern is already proven in this repo for the identical apex-vs-tenant
`/admin` clash (`next.config.ts:36-51`): apex `/admin/*` → `(saas-admin)/admin`,
tenant `/admin/*` → rewrite → `/dashboard/*` → `(tenant-admin)/dashboard`, with
the tenant folder deliberately named differently. We are copying that shape.

## Pass 1 — Workflow analysis

**Who uses this:** tenant members ("players") signing in and using their member
area on a tenant host; global customers using the platform-wide portal on the
apex; anyone arriving from a foundation-sent email link.

**Workflows that must survive, unchanged:**

1. Tenant member signs in at `{slug}/login` → lands on `/member` → nav across
   `/member/{session,reservations,promos,wallet,history,profile,settings,inquiries}`.
2. Global customer signs up/in on the apex → lands on the global portal home →
   sees their memberships → clicks through to a tenant.
3. A member follows a **password-reset** or **accept-invite** link from an email.
   These URLs are generated in `packages/agora` and hardcode `/portal/*`
   (`identity/member-auth/index.ts:148,154`, `identity/customer-auth/index.ts:104`).
4. A customer completes social sign-in; the foundation redirects to
   `/portal/login?error=…` on failure and `payload.next ?? "/portal"` on success
   (`identity/customer-auth/index.ts:755-866`).
5. Bookmarked `/portal/*` and `/member/*` URLs keep working.

**Failure cases to guard:**

- **Route collision** — the whole reason for this plan. Verified by a real dev-server
  boot, not by typecheck (typecheck does not catch it).
- **Tenant `/member/login` falling into the rewrite** and landing on a
  non-existent `/player/login` → 404 on the shared auth pages. See "The rewrite"
  below; this is the single highest-risk detail in the plan.
- **Foundation email links 404ing** — mitigated by blanket `/portal/* → /member/*`
  redirects rather than editing the shared foundation.
- **The global-portal auth gate opening or locking wrongly.**
  `(saas-member)/portal/global-portal-layout.tsx:13-17` holds a `PUBLIC_PATHS`
  array of `/portal/{login,sign-up,forgot,reset,accept-invite}` compared against
  `usePathname()`. If those strings are not updated in lockstep with the folder,
  the layout either redirects a signed-out visitor away from the login page
  (lockout) or treats a private page as public.
- **Nav highlighting / route gating on tenant hosts.** De-risked — see below.

**Audit/notifications:** none. This is routing only; no DB, no permissions, no
tenant-isolation surface. `rls:proof` is unaffected (run it anyway, it is cheap).

## Pass 2 — Technical findings

### `usePathname()` returns the browser URL, not the rewrite destination

This is the finding that makes the change small. `(tenant-admin)/dashboard/layout.tsx`
sits behind the `/admin/*` → `/dashboard/*` rewrite, and its `TITLES` map
(lines 129-171) is keyed on `/admin/*` while `crumbsFor(pathname)` (line 184)
builds lookups straight from `usePathname()` segments. That works in production,
which proves `usePathname()` yields `/admin/...`. (The inline comment on line 185
saying `["dashboard","settings","branding"]` is stale — the `TITLES` keys are the
real evidence.)

**Consequence:** on a tenant host the browser URL stays `/member/*`, so
`components/member/member-nav.config.ts:51-119` (absolute `/member/*` hrefs),
`matchMemberNav`, and `components/member/member-gate.tsx:43,119,129` (route
gating + the `?next=` it builds) **all keep working with no edits.** Do not
"fix" them to `/player/*`.

### `/portal/*` is two unrelated namespaces — do NOT blanket find/replace

| `/portal/*` occurrence | What it is | Action |
|---|---|---|
| `apps/chrono-api/src/app.ts:553-575` mounts, `lib/member/payments.ts`, `lib/customer-client.ts`, most `/portal/...` strings in `e2e/tests/member/*` | **API** paths on the Hono server (`:8787`) — `/portal/auth`, `/portal/members`, `/portal/wallet`, `/portal/credits`, `/portal/payments`, `/portal/activity`, `/portal/sessions`, `/portal/loyalty`, `/portal/customer` | **Leave untouched** |
| Web `href`/`location.href`/`page.goto` values listed in Phase 2 | Next.js page URLs | Change to `/member/*` |

A careless `sed s|/portal|/member|g` breaks every member API call. Phase 2 lists
the web call sites explicitly for this reason.

### The rewrite (the risky part)

Apex must serve `/member/{login,sign-up,forgot,reset,accept-invite}` from
`(saas-member)/member`, **and so must tenant hosts** — those five pages are
host-dual today (each has a `global-*-form.tsx` and a `tenant-*-form.tsx`) and
are the pages foundation emails point at. So the tenant catch-all rewrite must
not swallow them.

Primary form (single rule, negative lookahead — Next supports a regex on a named
`source` param):

```ts
{ source: "/member", missing: notApex, destination: "/player" },
{
  source: "/member/:path((?!login|sign-up|forgot|reset|accept-invite).*)",
  missing: notApex,
  destination: "/player/:path",
},
```

**Verify this against a running dev server, not by reading.** If Next's
path-to-regexp build rejects the lookahead, fall back to a positive allowlist of
the tenant tree's own top-level segments:

```ts
{
  source: "/member/:path(session|reservations|promos|wallet|history|profile|settings|inquiries|connect)/:rest*",
  missing: notApex,
  destination: "/player/:path/:rest*",
},
```

Record which form shipped in a code comment, and — if the fallback ships — note
that a new tenant member page must be added to the allowlist (it 404s loudly in
dev if forgotten). Do **not** attempt a self-destination rewrite
(`/member/login` → `/member/login`) as an exclusion trick; there is no precedent
for it here and it risks a loop.

`notApex` is the existing helper shape at `next.config.ts:37-40` / `62-65`
(`missing: [host apex, host www.apex]` = "on a tenant host").

### Redirects

Replace the three existing tenant-only redirects (`next.config.ts:66-77`) with
two blanket, host-unconditioned ones:

```ts
{ source: "/portal", destination: "/member", permanent: false },
{ source: "/portal/:path*", destination: "/member/:path*", permanent: false },
```

- Subsumes the current `/portal → /member`, `/portal/reservations`,
  `/portal/inquiries` tenant redirects.
- Keeps every foundation email + OAuth-callback link alive with **zero edits to
  `packages/agora`** — which matters, because that code is shared with
  `agora-web`, whose folder genuinely is `portal`. Next preserves the query
  string across redirects, so `?token=` and `?error=` survive.
- Apex `/portal/reservations` will redirect to a 404 (`/member/reservations`
  does not exist on the apex). It 404s today too — not a regression.
- Do **not** add a `/player/* → /member/*` canonicalising redirect: the `/admin`
  precedent leaves the physical `/dashboard/*` path reachable, and matching that
  keeps the two surfaces consistent.

## Open decision (please confirm before Phase 1)

**Recommended simplification: leave the five shared auth pages at `/portal/*`.**

If `(saas-member)/portal/{login,sign-up,forgot,reset,accept-invite}` stays put and
only the global-portal *home* moves to `(saas-member)/member`, then:

- the rewrite needs **no exclusions at all** (nothing named `login` exists under
  `/member`), removing the single riskiest detail in this plan;
- foundation email/OAuth URLs keep working with **no redirects**;
- `global-portal-layout.tsx`'s `PUBLIC_PATHS` needs no change, removing the
  lockout risk;
- Phase 2's href list shrinks to the handful pointing at `/portal` (the home).

Cost: the `(saas-member)` group spans two URL prefixes (`/member` for the home,
`/portal/*` for auth), which is less tidy — but those auth URLs are baked into
already-sent emails, so churning them is pure risk for no user-visible gain.

The plan below is written for the **full** rename you selected. Say the word and
I will cut it down to this variant instead.

## Phases

---

### Phase 1 — Folder renames + routing

Atomic: the app does not boot between the rename and the config change, so this
is one commit.

**Files to update**
- `apps/chrono-web/src/app/(saas-member)/portal/**` → `apps/chrono-web/src/app/(saas-member)/member/**` (21 files, `git mv`)
- `apps/chrono-web/src/app/(tenant-member)/member/**` → `apps/chrono-web/src/app/(tenant-member)/player/**` (13 files, `git mv`)
- `apps/chrono-web/next.config.ts` — add the tenant rewrite, replace the three redirects

**Step-by-step**
1. `git mv "apps/chrono-web/src/app/(saas-member)/portal" "apps/chrono-web/src/app/(saas-member)/member"`
2. `git mv "apps/chrono-web/src/app/(tenant-member)/member" "apps/chrono-web/src/app/(tenant-member)/player"`
3. In `next.config.ts` `rewrites().beforeFiles`, append the two `/member` rules
   from "The rewrite" above, **after** the existing `/admin` rules.
4. In `next.config.ts` `redirects()`, replace the three `/portal` entries with the
   two blanket entries from "Redirects" above.
5. Rewrite the block comment above `redirects()` (`next.config.ts:53-60`) — it
   currently explains the old `/portal → /member` split and becomes wrong.
6. Add a comment above the new rewrite rules explaining the collision they exist
   to avoid, and cross-referencing the `/admin` rules above as the precedent.

**Acceptance criteria**
- `pnpm --filter @agora/chrono-web dev` boots with **no** "parallel pages resolve
  to the same path" error.
- Apex `chrono2.localtest.me:3000/member` → global-customer portal home.
- Tenant `<slug>.localtest.me:3000/member` → member dashboard (MemberGate cascade).
- Tenant `<slug>.localtest.me:3000/member/wallet` → wallet page.
- Tenant `<slug>.localtest.me:3000/member/login` → the member login page (**not** a 404).
- Apex `chrono2.localtest.me:3000/member/login` → the global login page.
- `/portal` and `/portal/login` redirect to `/member` and `/member/login` on both hosts.
- Tenant `/player/wallet` still resolves directly (physical path, mirrors `/dashboard`).

**Verification**
```
pnpm --filter @agora/chrono-web dev      # boot check — the collision only shows here
pnpm typecheck
pnpm --filter @agora/api rls:proof       # unaffected, cheap, run it anyway
```

**Out of scope:** any `href` change (Phase 2), any `packages/agora` change (never).

**Execution start point:** the two `git mv` commands above.

---

### Phase 2 — In-app URLs + docs

Phase 1 leaves every `/portal/*` href working *through a redirect*. This phase
removes the extra hop and fixes the now-stale docs.

**Files to update** (web page URLs only — never the API paths from Pass 2)

Auth-gate array — highest risk, do first:
- `(saas-member)/member/global-portal-layout.tsx:13-17` — `PUBLIC_PATHS` → `/member/{login,sign-up,forgot,reset,accept-invite}`; also `:27`, `:47` (`location.href = "/portal/login"`), and the `:8` comment

Inside the renamed tree:
- `(saas-member)/member/login/global-login-form.tsx:53,64,100,106`
- `(saas-member)/member/sign-up/global-sign-up-form.tsx:58,71,118`
- `(saas-member)/member/reset/global-reset-form.tsx:45,80`
- `(saas-member)/member/forgot/global-forgot-form.tsx:66`
- `(saas-member)/member/page.tsx:3` and `layout.tsx:4-10` — both doc comments describe the old `/portal` split

Outside it:
- `(saas-landing)/page.tsx:525,554,986`
- `(saas-landing)/login/page.tsx:21`, `login/layout.tsx:37`
- `(tenant-landing)/stations/client.tsx:141,226`
- `components/staff-auth-chrome.tsx:58`
- `components/portal-auth-chrome.tsx:34`
- `components/member-login-form.tsx:107,113`
- `components/landing/player-cta-actions.tsx:56`
- `app/robots.ts:34` — `disallow: ["/dashboard", "/member", "/player", "/admin"]`, and rewrite the block comment (lines 8-18) which explains `/portal`

Docs:
- `apps/chrono-api/AGENTS.md:132-140,154,166-174` — the surface map. Already stale
  after `cd22a4cd` (still says `(member-area)/member` and `(member-portal)/portal`);
  bring it to `(saas-member)/member` + `(tenant-member)/player` and document the
  new rewrite + redirects.

**Acceptance criteria**
- No `/portal`-prefixed **page** URL remains in `apps/chrono-web/src`; every
  `/portal/*` **API** path is untouched.
- A signed-out visitor can still reach `/member/login` on both hosts (the
  `PUBLIC_PATHS` gate did not lock them out).
- Landing-page "join" / "sign in" CTAs go straight to `/member/*` with no redirect hop.

**Verification**
```
pnpm typecheck
grep -rn --include='*.tsx' --include='*.ts' -E "['\"\`]/portal(/login|/sign-up|/forgot|/reset|/accept-invite)?['\"\`?]" apps/chrono-web/src
# ^ expect zero page-URL hits; API-path hits are expected and correct
```

**Out of scope:** `packages/agora` (`auth-page-chrome.tsx:33`'s
`customerLoginHref = "/portal/login"` default stays — it is the `agora-web`
shape, and every Chrono call site passes its own value explicitly). Renaming
`components/portal-auth-chrome.tsx` or `e2e/tests/portal/` (cosmetic).

**Execution start point:** `global-portal-layout.tsx`'s `PUBLIC_PATHS`.

---

### Phase 3 — E2E

**Files to update**
- `e2e/tests/global-customers/apply-for-tenant.spec.ts:43` — `goto("/portal/sign-up")`
- `e2e/tests/global-customers/venue-status.spec.ts:73` — same
- `e2e/tests/public-stations/branded-availability.spec.ts:127` — href assertion
- `e2e/tests/tenant-landing/public-site-happy-path.spec.ts:92` — href assertion
- `e2e/tests/portal/global-social-login-ui.spec.ts` — the `/portal/login` +
  `/portal/sign-up` navigations in its header comment and body
- `e2e/tests/member/shell.spec.ts:7` — asserts the `/portal → /member` redirect;
  still valid, but re-point its comment at the new blanket redirect

**Leave alone:** `global-social-login-ui.spec.ts:102`
(`expect(next).toBe("/portal")`). That value comes from the foundation
(`customer-auth/index.ts:866`, `payload.next ?? "/portal"`), which this plan does
not touch; the resulting `/portal` lands on the redirect and reaches `/member`.
Add a one-line comment saying so, so a future reader does not "fix" it.

**Add** — a spec asserting the thing that broke twice, so a third regression is
caught by CI rather than by a developer:
`e2e/tests/member/host-route-split.spec.ts`
- apex `/member` renders the global portal home;
- tenant `/member` renders the member dashboard;
- tenant `/member/login` renders the login form (the rewrite-exclusion case);
- `/portal` redirects to `/member` on both hosts.

**Acceptance criteria:** the four updated specs and the new one pass; no spec
still drives a `/portal/*` page URL.

**Verification** — per `.ai/rules/rbac.md`, the browser suite is manual and needs
`pnpm dev` running first, with no `apps/chrono-api/.env` present:
```
pnpm dev                       # separate shell
pnpm --filter @agora/chrono-web test:e2e -- member/host-route-split.spec.ts
pnpm --filter @agora/chrono-web test:e2e -- global-customers tenant-landing public-stations portal
```

**Execution start point:** the two `page.goto` call sites.

---

## Out of scope (whole plan)

- Any change to `packages/agora` — including the hardcoded `/portal/*` email and
  OAuth URLs. The redirects cover them, and the foundation is shared with
  `agora-web`.
- Any API route path (`/portal/auth`, `/portal/members`, `/portal/wallet`, …).
- Any DB, schema, permission, or tenant-isolation change. Nothing here touches
  `APP_TENANT_TABLES`, RLS, or a permission gate.
- Merging the apex and tenant member surfaces into one host-branching tree (the
  alternative to a rewrite — rejected because the two layouts are incompatible:
  tenant wraps in `<MemberGate>`, apex in `<GlobalPortalLayout>`).
- Renaming `components/portal-auth-chrome.tsx`, `components/member/*`, or
  `e2e/tests/portal/`.

## Risks

1. **The rewrite regex.** The lookahead form is unverified against this Next
   version. Phase 1's acceptance criteria include the tenant `/member/login`
   case specifically; the allowlist fallback is specced above.
2. **Typecheck does not catch the collision.** Only a dev-server boot does. Phase 1
   is not done on a green `pnpm typecheck` alone.
3. **`PUBLIC_PATHS` drift** (Phase 2) can silently lock signed-out users out of
   the login page. It is listed first in that phase for this reason.
4. **Blind find/replace on `/portal`** breaks every member API call. Pass 2 has
   the namespace table; Phase 2 lists the web call sites individually.
