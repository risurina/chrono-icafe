# Member / Player route rename — `(saas-member)/member` + `(tenant-member)/player`

**Status:** in-progress — Phase 1 (folder renames + routing) complete and verified;
Phase 2 (in-app URLs + docs) and Phase 3 (e2e) not started.
**App:** chrono
**Sessions:**
- Planning: agora-a3 [4c723d]
- Audit: agora-a3 [4c723d]
- Implementation: agora-a3 [4c723d] (dispatched to a fresh subagent per `delegate-implementation`)

## Audit resolution

Audited once; verdict was "needs revision." The developer confirmed **keeping
the full rename** (all five auth pages move to `/member/*`, not the simplified
"only the home moves" alternative the audit preferred) — that decision is
final, do not re-raise it. The audit's other findings are fixed in this
revision:

1. **Corrected fact, changes the risk description but not the plan.** Pass 1/2
   originally said all five auth pages are "host-dual" (each has a
   `global-*-form.tsx` and a `tenant-*-form.tsx`). That's only true for
   `sign-up`/`forgot`/`reset`. `login/page.tsx` is **apex-only** and immediately
   `location.replace("/login")`s a tenant visitor; `accept-invite/page.tsx` has
   **no** host branching (one form, reached only via a foundation-emailed link,
   host-agnostic). Both still need the same rewrite exclusion as the other
   three — not because they render two ways, but because the URL
   `/member/{login,accept-invite}` must resolve to this tree on **either** host
   and must not be swallowed by the tenant catch-all. Fixed in "The rewrite"
   below.
2. Phase 3's e2e file list was 6 of ~30 files touching a `/portal` page URL —
   replaced with a generated list and an explicit policy for what does and
   doesn't need editing.
3. `global-portal-home.tsx`'s `tenantPortalUrl()` (a template-literal-built
   `/portal` link, invisible to a quote-anchored grep) added to Phase 2.
4. Phase 1's automated verification changed from an unbounded `pnpm dev` to
   `pnpm --filter @agora/chrono-web build` (bounded, scriptable, and `next
   build` raises the exact "parallel pages" error this phase exists to catch);
   the four host-specific runtime checks stay as a separate, explicitly
   bounded manual/curl pass.
5. `PUBLIC_PATHS` corrected to `PUBLIC` throughout (the actual export name in
   `global-portal-layout.tsx`) — matters if any phase is ever handed to Jules,
   which needs exact names per `.ai/rules/feature-planning.md`.
6. `apps/chrono-api/AGENTS.md` Phase 2 item widened to a full-file pass, not
   just the four originally-cited ranges (more stale `member-portal`/
   `member-area` mentions exist around lines 258, 324).

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

The prior-art Chrono implementation (`~/karta/karta-tenant/apps/chrono-web`,
distinct repo — see `reference_chrono_oikos_prior_art` memory) confirms the same
mechanism works in production for `/member` specifically: it has two physically
distinct folders, `src/app/member` (apex) and `src/app/tenant/landing/member`
(tenant, nested three levels deeper), and its `next.config.ts` rewrites
tenant-host `/member/*` → `/tenant/landing/member/*`. Its tenant folder is *also*
literally named `member` — the reason there is no collision there is that
`/member` and `/tenant/landing/member` are different physical URLs, not that the
folder basename differs. This plan's `player` rename is the same
differing-physical-URL trick with a flat name instead of a nested one; both are
valid, and the nested form is not simpler for us since it would require
inventing a new intermediate segment (`(tenant-member)/???/member`) with no
existing meaning in this codebase, whereas `player` already has one.

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
  `(saas-member)/portal/global-portal-layout.tsx:12-17` holds a `PUBLIC` array
  of `/portal/{login,sign-up,forgot,reset,accept-invite}` compared against
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
`(saas-member)/member`, **and so must tenant hosts** — foundation emails and
OAuth-callback redirects point at these paths regardless of which host the
recipient is on. So the tenant catch-all rewrite must not swallow them. This
holds for all five, but not for the same reason in each case (corrected per
the audit — do not assume uniform host-duality):

- `sign-up`, `forgot`, `reset` genuinely render two ways: each has both a
  `global-*-form.tsx` and a `tenant-*-form.tsx`, chosen by host at runtime.
- `login/page.tsx` is **apex-only** — on a tenant host it immediately
  `location.replace("/login")`s away. It still needs the exclusion so that
  replace can run at all; without it, the tenant rewrite would send
  `/member/login` to a non-existent `/player/login` before the page ever
  mounts.
- `accept-invite/page.tsx` has no host branching at all — one form, reached
  only via a foundation-emailed link that carries no host guarantee. It needs
  the exclusion for the same reason: the URL must resolve to this page
  wherever the link is opened.

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

## Phases

---

### Phase 1 — Folder renames + routing — ✅ DONE

**Result:** the negative-lookahead rewrite form shipped as specced — no
allowlist fallback was needed. `pnpm --filter @agora/chrono-web build`
compiled cleanly with `/member` (apex tree) and `/player` (tenant tree) as
distinct routes and no "parallel pages resolve to the same path" error;
`pnpm typecheck` passed across all 7 workspace tasks; `pnpm --filter @agora/api
rls:proof` printed `RLS PROOF: PASS ✅` (non-vacuous). Manual curl pass against
a live `pnpm --filter @agora/chrono-web dev` (apex host `localtest.me:3000`,
tenant host `acme.localtest.me:3000`, the seeded `acme` org) returned `200` for
apex `/member`, apex `/member/login`, apex `/member/sign-up`, tenant `/member`,
tenant `/member/login`, tenant `/member/sign-up`, tenant `/member/accept-invite`,
tenant `/member/wallet`, and tenant `/player/wallet`; `/portal` and
`/portal/login` on the tenant host returned `307` to `/member` and
`/member/login` respectively. Committed as `<see commit below>`.

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

Automated gate — bounded, catches the exact route-manifest error this phase
exists to guard against (`next build` raises "parallel pages resolve to the
same path" the same as `next dev`, but exits cleanly instead of hanging):
```
pnpm --filter @agora/chrono-web build
pnpm typecheck
pnpm --filter @agora/api rls:proof       # unaffected, cheap, run it anyway
```

Manual runtime pass — the four host-specific acceptance criteria above cannot
be verified by `build` alone; run bounded, don't leave `dev` running unwatched:
```
timeout 60 pnpm --filter @agora/chrono-web dev &
sleep 8
curl -s -o /dev/null -w '%{http_code} apex /member\n'          http://chrono2.localtest.me:3000/member
curl -s -o /dev/null -w '%{http_code} apex /member/login\n'    http://chrono2.localtest.me:3000/member/login
curl -s -o /dev/null -w '%{http_code} tenant /member\n'        http://<slug>.localtest.me:3000/member
curl -s -o /dev/null -w '%{http_code} tenant /member/login\n'  http://<slug>.localtest.me:3000/member/login
curl -s -o /dev/null -w '%{http_code} tenant /member/wallet\n' http://<slug>.localtest.me:3000/member/wallet
curl -s -o /dev/null -w '%{http_code} tenant /player/wallet\n' http://<slug>.localtest.me:3000/player/wallet
curl -s -I http://<slug>.localtest.me:3000/portal | head -1     # expect a 307/308 to /member
kill %1
```
All must be `200` (the two redirect checks aside) — any `404` on `/member/login`
on either host means the rewrite exclusion in "The rewrite" above didn't take.

**Out of scope:** any `href` change (Phase 2), any `packages/agora` change (never).

**Execution start point:** the two `git mv` commands above.

---

### Phase 2 — In-app URLs + docs

**Status: complete.**

Updated every in-app web page `/portal` URL to `/member` (auth-gate `PUBLIC` array
in `global-portal-layout.tsx` first, its two `location.href` sign-out/redirect
sites, all five auth-form pages under the renamed `(saas-member)/member` tree,
`global-portal-home.tsx`'s template-literal `tenantPortalUrl()`, both doc
comments in `page.tsx`/`layout.tsx`, and every landing/nav/chrome call site
listed below). Left every `/portal/*` **API** path untouched (payments,
credits, customer-apply, etc.). Brought `apps/chrono-api/AGENTS.md` up to date
via a full-file grep pass (not just the originally-cited ranges) — fixed the
stale `(member-area)/member`/`(member-portal)/portal` folder mentions, the
apex global-customer page URLs, and one stale API-vs-page mixup (the
`/portal/credits?payment=<id>` return page is a page URL, corrected to
`/member/credits?payment=<id>`; the API paths it polls stayed `/portal/*`).

**Verification actually run:**
```
pnpm typecheck                                   # PASS (7/7 tasks)
pnpm --filter @agora/api rls:proof               # RLS PROOF: PASS ✅ (unaffected, ran anyway)
grep -rn ... quote-anchored /portal(...)  apps/chrono-web/src   # zero page-URL hits
grep -rn ... unanchored     /portal(...)  apps/chrono-web/src   # zero page-URL hits
```
Both grep forms return exactly one hit, in
`components/landing/player-cta-actions.tsx:25` — a comment describing the
still-`/portal`-navigating e2e spec (`apply-for-tenant.spec.ts`), which is
Phase 3's job to touch, not Phase 2's. No other `/portal` page-URL reference
remains; every remaining `/portal` hit in either `apps/chrono-web/src` or
`apps/chrono-api/AGENTS.md` is an API path or an archived-plan filename.

Manual dev-server pass (`pnpm --filter @agora/chrono-web dev`, curl against
`localtest.me:3000` + `acme.localtest.me:3000`): apex `/member` → 200, apex
`/member/login` → 200 (renders login form, no lockout), tenant `/member` →
200, tenant `/member/login` → 200 (renders login form — confirms the `PUBLIC`
array fix did not lock out signed-out visitors on either host), tenant
`/member/wallet` → 200, tenant `/player/wallet` → 200 (physical path still
reachable directly), `/portal` → `307` → `/member` on both hosts.

No deviations from the plan; no new risks discovered.

Phase 1 leaves every `/portal/*` href working *through a redirect*. This phase
removes the extra hop and fixes the now-stale docs.

**Files to update** (web page URLs only — never the API paths from Pass 2)

Auth-gate array — highest risk, do first:
- `(saas-member)/member/global-portal-layout.tsx:12-17` — `PUBLIC` → `/member/{login,sign-up,forgot,reset,accept-invite}`; also `:27`, `:47` (`location.href = "/portal/login"`), and the `:8` comment

Inside the renamed tree:
- `(saas-member)/member/login/global-login-form.tsx:53,64,100,106`
- `(saas-member)/member/sign-up/global-sign-up-form.tsx:58,71,118`
- `(saas-member)/member/reset/global-reset-form.tsx:45,80`
- `(saas-member)/member/forgot/global-forgot-form.tsx:66`
- `(saas-member)/member/global-portal-home.tsx:20-23,55` — `tenantPortalUrl(slug)`
  builds `` `${scheme}://${slug}.${appDomain}/portal` `` via template-literal
  interpolation (invisible to a quote-anchored grep — see the fixed
  verification pattern below); this is the "Go to portal →" link to a tenant
  host and must become `/member`. Also its doc comment referencing "that
  business's `/portal`".
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
- `apps/chrono-api/AGENTS.md` — full-file pass, not just one range. Already
  stale after `cd22a4cd` (still says `(member-area)/member` and
  `(member-portal)/portal` in places — confirmed stale mentions at lines
  132-140, 154, 166-174, 258, 324). Bring every mention to `(saas-member)/member`
  + `(tenant-member)/player` and document the new rewrite + redirects.
  `grep -n "member-portal\|member-area\|/portal" apps/chrono-api/AGENTS.md`
  before editing to catch anything beyond the ranges above.

**Acceptance criteria**
- No `/portal`-prefixed **page** URL remains in `apps/chrono-web/src`; every
  `/portal/*` **API** path is untouched.
- A signed-out visitor can still reach `/member/login` on both hosts (the
  `PUBLIC_PATHS` gate did not lock them out).
- Landing-page "join" / "sign in" CTAs go straight to `/member/*` with no redirect hop.

**Verification**
```
pnpm typecheck
# Quote/backtick-anchored form (catches string-literal hrefs):
grep -rn --include='*.tsx' --include='*.ts' -E "['\"\`]/portal(/login|/sign-up|/forgot|/reset|/accept-invite)?['\"\`?]" apps/chrono-web/src
# Unanchored form (also catches template-literal joins like `${x}/portal`,
# which the quote-anchored pattern misses — this is what caught
# global-portal-home.tsx's tenantPortalUrl() in the audit):
grep -rn --include='*.tsx' --include='*.ts' -E "/portal(/login|/sign-up|/forgot|/reset|/accept-invite)?['\"\`?]" apps/chrono-web/src
# ^ both: expect zero page-URL hits; API-path hits (/portal/auth, /portal/members,
# /portal/wallet, /portal/credits, /portal/payments, /portal/activity,
# /portal/sessions, /portal/loyalty, /portal/customer) are expected and correct
```

**Out of scope:** `packages/agora` (`auth-page-chrome.tsx:33`'s
`customerLoginHref = "/portal/login"` default stays — it is the `agora-web`
shape, and every Chrono call site passes its own value explicitly). Renaming
`components/portal-auth-chrome.tsx` or `e2e/tests/portal/` (cosmetic).

**Execution start point:** `global-portal-layout.tsx`'s `PUBLIC_PATHS`.

---

### Phase 3 — E2E

The audit found the original file list (6 files) was far short — regenerate it
before editing rather than trusting either version. As of this plan's writing:

```
grep -rln "portal" apps/chrono-web/e2e/tests --include='*.spec.ts' | sort
```
returns **33 files**. Not all need edits — split them by what they actually do:

**Category A — asserts a literal rendered `href`/redirect value. MUST be fixed**,
because Phase 2 changes the actual page output and these would start failing,
not passing-by-accident:
- `e2e/tests/public-stations/branded-availability.spec.ts:127` —
  `toHaveAttribute("href", "/portal/sign-up")` → `/member/sign-up`
- `e2e/tests/tenant-landing/public-site-happy-path.spec.ts:92` — same
- `e2e/tests/member/shell.spec.ts` — asserts the `/portal → /member` redirect
  behavior; re-point at the new blanket redirect and its comment (`:7`)

**Category B — `page.goto(...)` used only as a bootstrap step to reach the
sign-up/login form, not asserting a URL.** ~28 files, all following the same
`page.goto(\`${base}/portal/sign-up\`)` (or `/portal/login`, `/portal`) shape —
`e2e/tests/{stations,reconciliation,inquiries,reservations,public-stations
[dup],global-customers,member,loyalty,qr,pos,sessions,wallet,members,credits,
auth}/*.spec.ts` plus everything under `e2e/tests/portal/`. Generate the exact
list at execution time with:
```
grep -rln -E "goto\(.*/portal(/login|/sign-up)?[\`'\"]" apps/chrono-web/e2e/tests --include='*.spec.ts'
```
**Decision: leave these as `/portal/*` navigations, relying on Phase 1's
blanket redirect** (`/portal/:path* → /member/:path*`, 307/308, tested directly
in Phase 1's manual pass). This is a deliberate scope cut, not an oversight —
rewriting ~28 near-identical call sites for a URL the redirect already handles
correctly is churn with no behavior change. If any of these specs assert
`page.url()` **after** the goto (a few do, for `next=` round-trips — check each
before assuming it's pure bootstrap), that assertion moves into Category A.

**Leave alone entirely:** `global-social-login-ui.spec.ts:102`
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
- apex `/member/login` renders the global login form;
- tenant `/member/accept-invite` does not 404 (the no-host-branching case);
- `/portal` redirects to `/member` on both hosts.

**Acceptance criteria:**
- Every Category A spec passes against the new hrefs (not the old ones).
- The new `host-route-split.spec.ts` passes.
- Category B specs are explicitly *not* required to stop using `/portal/*` —
  the acceptance bar is "still passes via the redirect," confirmed by actually
  running a representative sample (see Verification), not by grepping for zero
  `/portal` references.

**Verification** — per `.ai/rules/rbac.md`, the browser suite is manual and needs
`pnpm dev` running first, with no `apps/chrono-api/.env` present:
```
pnpm dev                       # separate shell
pnpm --filter @agora/chrono-web test:e2e -- member/host-route-split.spec.ts
pnpm --filter @agora/chrono-web test:e2e -- public-stations/branded-availability.spec.ts tenant-landing/public-site-happy-path.spec.ts member/shell.spec.ts
# Representative sample of Category B, to confirm the redirect-reliance decision holds:
pnpm --filter @agora/chrono-web test:e2e -- global-customers portal member/dashboard.spec.ts
```

**Execution start point:** run the two `grep` commands above to produce the
real, current file lists before touching anything — do not reuse this plan's
lists verbatim if time has passed and new specs were added.

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
