# Global portal — split "Your account" into `/member/profile`, split the directory into tabs

**App:** chrono
**Sessions:**
- Planning: this session (no `ListAgents` identity available in this environment)
- Implementation: dispatched to a fresh subagent per `delegate-implementation`
  (Phase 1 committed at `ed354b8a` on `feature/member-profile-page-lounge-tabs`,
  worktree `.ai/worktree/member-profile-page-lounge-tabs`)

## Decisions (developer, this session)

1. New route `apps/chrono-web/src/app/(saas-member)/member/profile/page.tsx` hosts the
   "Your account" identity card, moved out of `/member` (`global-portal-home.tsx`).
   `/member/profile` on a tenant host already rewrites to `/player/profile`
   (`next.config.ts`'s existing `/member/:path*` → `/player/:path*` rule) — this plan
   only adds the apex-side physical page, no config change needed.
2. `/member` drops the "Your account" card entirely once it moves — no inline
   name/email summary left behind. Just the welcome heading + the directory.
3. The Gaming Lounge Directory splits into two tabs: **"My Lounges"** (tenants the
   customer has already joined) and **"Discover Lounges"** (every other reachable
   tenant) — using `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `agora/ui`, the
   same primitives already used at
   `apps/chrono-web/src/app/(saas-admin)/admin/settings/page.tsx`.
4. `GlobalPortalSidebar` gains a "Profile" nav item (`/member/profile`) — the sidebar's
   own comment (`components/member/global-portal-sidebar.tsx:17-19`) already flagged
   this as deferred pending the route existing.

## Pass 1 — Workflow analysis

**Who:** a signed-in global customer (`agora/customer-auth`) on the apex
(`chrono2.izur.com.ph/member`).

**Workflow today:** customer lands on `/member`, sees a "Your account" card
(name/email only) then the full "Gaming Lounge Directory" grid (every reachable
tenant, "Enter Portal" if a member, "Apply to Join" otherwise) below it, with no
way to separate "lounges I belong to" from "lounges I could join" except reading
each card.

**Workflow after this change:** customer lands on `/member`, sees the welcome
heading and the directory, split into "My Lounges" (their joined tenants) and
"Discover Lounges" (everything else) tabs — "My Lounges" is the default/active tab
since it's the higher-value view for a returning member. Account details (name/
email) move to a dedicated `/member/profile` page, reachable from the sidebar.

**Failure cases (all pre-existing, must not regress):**
- Signed-out visitor → `GlobalPortalLayout`'s existing redirect-to-`/member/login`
  gate wraps every page under `(saas-member)/member`, including the new
  `/member/profile` — no changes needed there, it already applies shell-wide.
- Directory list API failure → today renders an inline error message instead of the
  grid; after tabbing, that error message must render in place of both tabs (not
  duplicated per-tab), i.e. keep the existing `directoryError` branch above the
  `Tabs` block, only wrap the successful-grid case in tabs.
- A tenant that isn't `active`/`trial`/`pending` (suspended/cancelled/archived) must
  still never render a card, in either tab — unaffected, `REACHABLE_STATUSES`
  filtering happens per-card in `LoungeDirectoryCard`/server-side already; the tab
  split only partitions by `memberSlugs`, not status.
- A customer with zero joined tenants must see an empty "My Lounges" tab with a
  clear message pointing at "Discover Lounges", not a blank pane.
- A customer who has joined every listed tenant must see an empty "Discover
  Lounges" tab with a "you've joined them all" message, not a blank pane.

**Audit/notifications:** none new. No permission gate changes, no schema change, no
new API route — this is a pure client-side reorganization of already-fetched data
(`memberships`, `directory`) plus one new page that reads the same
`useGlobalCustomerSession()` data `global-portal-home.tsx` already reads.

## Pass 2 — Technical findings

### `/member/profile` route placement is safe, already reasoned about

The prior `portal-lounge-directory-redesign` plan explicitly checked for this route
and found it didn't exist yet, leaving the sidebar's Profile item out with a
"confirm during implementation" comment. `next.config.ts`'s tenant-host rewrite
(`/member/:path((?!login|sign-up|forgot|reset|accept-invite).*)` → `/player/:path`)
already covers `/member/profile` on a tenant host — it rewrites to the existing
tenant-side `/player/profile` page, a different, already-shipped page. This plan's
new page is apex-only and only ever renders when `notApex` is true (the apex host),
so there is no collision to resolve.

### "Your account" content to move, verbatim

`global-portal-home.tsx:95-108`'s `Card`/`CardHeader`/`CardTitle`/`CardDescription`/
`CardContent` block, reading `customer?.name`/`customer?.email` from
`useGlobalCustomerSession()` — moves into a new client component almost unchanged
(same markup, same data source, no new fetch).

### Directory split is pure client-side partitioning, no new API

`global-portal-home.tsx` already computes `memberSlugs` (a `Set<string>` from
`memberships`) and renders one `directory.map(...)` grid. The tabs need two filtered
views of the same `directory` array — `directory.filter(item =>
memberSlugs.has(item.slug))` for "My Lounges", `directory.filter(item =>
!memberSlugs.has(item.slug))` for "Discover Lounges" — no new fetch, no new
contract, no backend change.

### Radix `Tabs` unmounts inactive content — matters for the e2e spec

`packages/agora/src/presentation/ui/components/tabs.tsx` wraps `@radix-ui/react-tabs`
with no `forceMount`, so `TabsContent` for the inactive tab is not in the DOM at
all (not just hidden) while that tab isn't selected. The existing
`apps/chrono-web/e2e/tests/member/lounge-directory.spec.ts` currently asserts
`lounge-directory-card`/`lounge-directory-card-cta` directly on page load — once
these are split under tabs, the spec must first assert the default tab ("My
Lounges") shows the joined-tenant card, then click the "Discover Lounges"
`TabsTrigger` and assert the unjoined-tenant card only appears after that click.

## Files to update / create

Frontend (`apps/chrono-web`), no backend/schema/contract changes:

- `src/app/(saas-member)/member/profile/page.tsx` **(new)** — thin page, mirrors
  `member/page.tsx`'s shape (`export default function` rendering the client
  component below).
- `src/app/(saas-member)/member/profile/global-portal-profile.tsx` **(new)** —
  client component (`"use client"`), reads `useGlobalCustomerSession()`, renders
  the "Your account" `Card` moved verbatim from `global-portal-home.tsx`, plus the
  existing welcome-style heading pattern adapted to a "Profile" page title.
- `src/app/(saas-member)/member/global-portal-home.tsx` — remove the "Your
  account" `Card` block entirely (lines 95-108); wrap the existing directory grid
  in `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` (`agora/ui`) with two tabs keyed
  `"my-lounges"` (default) and `"discover-lounges"`; each `TabsContent` filters
  `directory` by `memberSlugs` as above and renders the existing
  `grid gap-6 sm:grid-cols-2 lg:grid-cols-3` of `LoungeDirectoryCard`s, each with
  its own empty-state message when its filtered list is empty; keep the existing
  `directoryError`/loading branches above the `Tabs` block, unchanged, so an API
  failure still shows one message instead of two empty tabs.
- `src/components/member/global-portal-sidebar.tsx` — add
  `{ label: "Profile", href: "/member/profile", icon: User }` (lucide `User`) to
  `NAV_ITEMS`, between "Dashboard" and the Logout button; delete the now-stale
  "No Profile item" comment block (lines 17-19).

## Acceptance criteria

- `/member/profile` renders the customer's name and email in a "Your account"
  card, reachable via the sidebar's new "Profile" link, and is gated by the same
  signed-out redirect as every other `(saas-member)/member` page (no new gate
  code needed — verify the existing `GlobalPortalLayout` check still applies).
- `/member` no longer shows any account/identity details — only the welcome
  heading and the tabbed directory.
- "My Lounges" tab shows exactly the tenants in `memberships`; "Discover Lounges"
  shows exactly the reachable tenants not in `memberships`. Neither tab shows a
  suspended/cancelled/archived tenant.
- A customer with zero joined tenants sees a non-blank "My Lounges" empty state
  that points at "Discover Lounges"; a customer who has joined every listed
  tenant sees a non-blank "Discover Lounges" empty state.
- Directory API failure still renders a single error message in place of the
  tabs, not two broken/empty tab panes.
- No hardcoded color literals; all new markup uses `agora/ui` primitives and
  semantic tokens (`.ai/rules/styling.md`, `.ai/rules/component-first-ui.md`).

## E2E

Update the existing spec (required — this is the same customer-facing surface
`portal-lounge-directory-redesign` already covered, not a new tenant-scoped
resource, but the change is behavior-visible enough to keep the existing coverage
accurate rather than let it silently start asserting against stale markup):

- `apps/chrono-web/e2e/tests/member/lounge-directory.spec.ts` — update to select
  the "My Lounges" tab (default) for the joined-tenant assertion, click into
  "Discover Lounges" for the unjoined-tenant assertion, keep the suspended-tenant
  and apply-to-join navigation assertions as-is.
- New spec or extend an existing `member/*.spec.ts`: sign in, click sidebar
  "Profile", assert `/member/profile` renders the signed-in customer's name and
  email.

## Out of scope

- Any backend/contract/route change — this is a pure frontend reorganization of
  already-fetched data.
- Editing the "Your account" fields shown (still just name + email) — no new
  profile fields, avatar, or edit form. That is `member-profile-security-and-avatar`
  territory (already archived, tenant-side `/player/profile` — unrelated page) if
  ever extended to the global-customer profile.
- Any change to `applyForTenantMembership()`, `LoungeDirectoryCard`, or
  `tenantHref()` — reused as-is.
- Any change to `next.config.ts`'s rewrite rules — the existing `/member/:path*`
  → `/player/:path*` rule already covers `/member/profile` on a tenant host
  correctly.
- Renaming `/member` itself or its route group — out of scope, already settled by
  `member-player-route-rename`.

## Verification commands

```
pnpm typecheck
pnpm --filter @agora/chrono-web build
pnpm --filter @agora/chrono-web test:e2e -- member/lounge-directory.spec.ts
```

## Execution start point

Create `src/app/(saas-member)/member/profile/global-portal-profile.tsx`, moving the
"Your account" `Card` block out of `global-portal-home.tsx` verbatim.

## Phases

---

### Phase 1 — `/member/profile` page + sidebar nav — COMPLETE

**Verification summary:** Implemented on `feature/member-profile-page-lounge-tabs`
(worktree `.ai/worktree/member-profile-page-lounge-tabs`), commit `ed354b8a`. Created
`global-portal-profile.tsx` (reads `useGlobalCustomerSession()`, renders the "Your
account" `Card` moved verbatim) and `profile/page.tsx` (thin default export, mirrors
`member/page.tsx`'s shape). Removed the "Your account" `Card` block and its now-unused
`Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent` import from
`global-portal-home.tsx` — welcome heading and directory grid untouched. Added `User`
(lucide-react) to `global-portal-sidebar.tsx`'s `NAV_ITEMS` after "Dashboard" and
removed the stale "No Profile item" comment block.

`pnpm typecheck` — pass (7/7 workspace packages). `pnpm --filter @agora/chrono-web
build` — pass; `/member/profile` confirmed as a generated route in the build output.
Manual verification: did not start `pnpm dev` (impractical in the dispatch
environment); instead confirmed via the production build's route listing that
`/member/profile` compiles and is routable, and re-read the diff against the
acceptance criteria — `GlobalPortalProfile` reads `customer?.name`/`customer?.email`
identically to the removed card, and `global-portal-home.tsx` no longer references
account details. A follow-up manual browser pass (sign in, click sidebar "Profile",
confirm the rendered page) is still recommended before this phase is considered fully
verified end-to-end, since the dispatch environment couldn't run `pnpm dev`.

**Files to update**
- `apps/chrono-web/src/app/(saas-member)/member/profile/page.tsx` (new)
- `apps/chrono-web/src/app/(saas-member)/member/profile/global-portal-profile.tsx` (new)
- `apps/chrono-web/src/app/(saas-member)/member/global-portal-home.tsx`
- `apps/chrono-web/src/components/member/global-portal-sidebar.tsx`

**Step-by-step tasks**
1. Create `global-portal-profile.tsx`: `"use client"` component, call
   `useGlobalCustomerSession()`, render a page heading ("Profile") and the "Your
   account" `Card` moved verbatim from `global-portal-home.tsx:95-108`.
2. Create `profile/page.tsx`: thin default export rendering
   `<GlobalPortalProfile />`, mirroring `member/page.tsx`'s existing shape and its
   "Apex-only" comment.
3. In `global-portal-home.tsx`, delete the "Your account" `Card` block
   (lines 95-108) — the welcome heading stays.
4. In `global-portal-sidebar.tsx`, import `User` from `lucide-react`, add
   `{ label: "Profile", href: "/member/profile", icon: User }` to `NAV_ITEMS`
   after "Dashboard", and delete the stale "No Profile item" comment
   (lines 17-19).

**Acceptance criteria**
- `/member/profile` renders name/email for the signed-in customer.
- `/member` no longer renders any account details.
- Sidebar shows Dashboard, Profile, Logout, in that order; Profile links to
  `/member/profile` and highlights active when on that route (existing
  `pathname === href` logic already handles this with no changes).

**Verification**
```
pnpm typecheck
pnpm --filter @agora/chrono-web build
```
Manual: `pnpm --filter @agora/chrono-web dev`, sign in as a global customer at
`chrono2.localtest.me:3000/member`, click "Profile" in the sidebar, confirm name/
email render at `/member/profile`.

**Out of scope:** the directory/tabs change (Phase 2).

**Execution start point:** create `global-portal-profile.tsx`.

---

### Phase 2 — Split the directory into "My Lounges" / "Discover Lounges" tabs — COMPLETE

**Verification summary:** Implemented on `feature/member-profile-page-lounge-tabs`,
commit `553b25ad`. `global-portal-home.tsx` now imports `Tabs`/`TabsList`/
`TabsTrigger`/`TabsContent` from `agora/ui`; computes `myLounges`/`discoverLounges` by
filtering the existing `directory` array against the existing `memberSlugs` Set (no
new fetch); renders a `Tabs defaultValue="my-lounges"` block with two panes, each the
same `grid gap-6 sm:grid-cols-2 lg:grid-cols-3` of `LoungeDirectoryCard`s as before,
each with its own non-blank empty state. The top-level `directoryError`/
`directory.length === 0` branches are untouched and still gate whether the `Tabs`
block renders at all.

`pnpm typecheck` — pass (7/7 workspace packages). `pnpm --filter @agora/chrono-web
build` — pass; `/member` and `/member/profile` both confirmed in the generated route
list. Manual browser verification was not done (no seeded DB/session in the dispatch
environment) — a follow-up manual pass (sign in as a customer who has joined at least
one but not all listed tenants, confirm both tabs populate and switching works) is
still recommended before Phase 3's e2e spec is written, since that spec will need to
exercise the same tab-click flow.

**Files to update**
- `apps/chrono-web/src/app/(saas-member)/member/global-portal-home.tsx`

**Step-by-step tasks**
1. Import `Tabs, TabsList, TabsTrigger, TabsContent` from `agora/ui`.
2. Compute `myLounges = directory.filter(item => memberSlugs.has(item.slug))` and
   `discoverLounges = directory.filter(item => !memberSlugs.has(item.slug))`.
3. Replace the single grid with:
   `<Tabs defaultValue="my-lounges">` → `<TabsList>` with two
   `<TabsTrigger value="my-lounges">My Lounges</TabsTrigger>` /
   `<TabsTrigger value="discover-lounges">Discover Lounges</TabsTrigger>` →
   two `<TabsContent>` panes, each rendering the existing
   `grid gap-6 sm:grid-cols-2 lg:grid-cols-3` of `LoungeDirectoryCard`s from its
   filtered list.
4. Add a per-tab empty-state message: "My Lounges" empty → something like
   "You haven't joined a lounge yet — check Discover Lounges to apply."; "Discover
   Lounges" empty → "You've already joined every lounge in the directory."
5. Keep the existing top-level `directoryError`/`directory.length === 0 &&
   !directoryError` branches exactly as they are today, gating the whole `Tabs`
   block (i.e. only render `Tabs` once the directory fetch has actually
   succeeded with at least one reachable tenant total).

**Acceptance criteria**
- "My Lounges" (default-active) shows only joined tenants; "Discover Lounges"
  shows only non-joined tenants.
- Neither tab ever shows a non-reachable-status tenant (unaffected — status
  filtering is per-card already).
- Each tab has its own non-blank empty state.
- A directory-fetch failure still shows one error message, not two tabs.

**Verification**
```
pnpm typecheck
pnpm --filter @agora/chrono-web build
```
Manual: sign in as a global customer who has joined at least one but not all
listed tenants; confirm both tabs populate correctly and switching tabs works.

**Out of scope:** Phase 1's profile page.

**Execution start point:** add the `Tabs` import and the two filtered arrays.

---

### Phase 3 — E2E — COMPLETE

**Verification summary:** Implemented on `feature/member-profile-page-lounge-tabs`,
commits `9f8af7b0` (initial specs) and `7fe1739c` (fixes found by actually running the
suite). `lounge-directory.spec.ts` updated to be tab-aware: the joined-tenant/
suspended-tenant assertions run against the default-active "My Lounges" tab with no
click, then `page.getByRole("tab", { name: "Discover Lounges" }).click()` before
asserting the unjoined-tenant card and re-checking suspended-tenant absence there too.
New file `apps/chrono-web/e2e/tests/member/global-portal-profile.spec.ts` (named to
avoid colliding with the existing tenant-side `profile-settings.spec.ts`/
`profile-security-and-avatar.spec.ts`, which cover the unrelated `/player/profile`
page) signs up a fresh global customer, clicks the sidebar "Profile" link, and asserts
`/member/profile` renders that customer's name/email.

**Both specs run for real against live dev servers and pass** — not just statically
verified. `apps/chrono-web`'s actual npm script is `e2e`, not `test:e2e` as this
plan's own "Verification" section below assumed; `npx playwright test <path>` was
used directly instead once `pnpm --filter ... e2e -- <path>` was found to mis-forward
a literal `"--"` to Playwright's CLI (ran the full suite instead of the target spec).
Ran on alternate ports (chrono-api :8790, chrono-web :3005 via env overrides) since
the default ports were occupied by another session, `.env` files copied unread from
the main checkout and deleted after, per this repo's own precedent in
`portal-lounge-directory-redesign`. `pnpm --filter @agora/chrono-api run seed` reseeded
the existing tracked fixtures (`gaming`/`acme`/`contoso`/`globex` + global customer +
platform admin/viewer) against the project's single dev/staging Neon project.

First run surfaced two genuine test-locator bugs (not app bugs), fixed in `7fe1739c`:
1. Email assertion compared against the faker-generated mixed-case email, but
   `agora/customer-auth` lowercases email on signup — normalized with
   `.toLowerCase()` before asserting.
2. `page.getByText(name/email, { exact: true })` was a strict-mode violation — the
   sidebar renders the same name/email on every `/member/*` page, so the bare
   page-level locator matched twice. Scoped both assertions to `page.locator("dl")`
   (the profile card's own definition list).

Final result: `global-portal-profile.spec.ts` — 1 passed. `lounge-directory.spec.ts` —
1 passed (58.3s).

**Files to update**
- `apps/chrono-web/e2e/tests/member/lounge-directory.spec.ts`
- A `member/*.spec.ts` covering `/member/profile` (new file or extend an existing
  one — implementer's call based on the nearest existing spec's shape)

**Step-by-step tasks**
1. Update `lounge-directory.spec.ts`: assert the joined-tenant card appears in
   the default "My Lounges" tab without any click; click the "Discover Lounges"
   `TabsTrigger`, then assert the unjoined-tenant card appears; keep the
   suspended-tenant-never-renders and apply-to-join-navigates assertions as-is
   (just re-target them at whichever tab now contains that card).
2. Add/extend a spec: sign in as the existing seeded global customer, click
   sidebar "Profile", assert `/member/profile` renders that customer's name and
   email.

**Acceptance criteria**
- Both specs pass locally against `pnpm dev`.

**Verification**
```
pnpm dev                       # separate shell
pnpm --filter @agora/chrono-web test:e2e -- member/lounge-directory.spec.ts
```

**Out of scope:** re-running the full existing `member/*` e2e suite.

**Execution start point:** update `lounge-directory.spec.ts`'s tab-selection
assertions first (highest risk of silently going stale).

## Closure

All 3 phases complete and verified. A separate follow-up fix (sticky sidebar on
`/member`, not part of this plan's original scope) was implemented on its own branch
`fix/member-portal-sticky-sidebar` and merged alongside this plan's work.

Merged into local `main` (not yet pushed to `origin`):
- `ed354b8a`, `fe25dfb0` — Phase 1
- `553b25ad`, `da8b2111` — Phase 2
- `9f8af7b0` — Phase 3 (initial e2e specs)
- `b4cd94ab` — sticky-sidebar fix (separate branch, unrelated follow-up)
- `7fe1739c` — Phase 3 e2e fixes found by actually running the suite
- `f32eee1f` — merge commit

Worktrees `.ai/worktree/member-profile-page-lounge-tabs` and
`.ai/worktree/member-portal-sticky-sidebar` are still present on disk — safe to remove
(`git worktree remove`) once the developer confirms no further work is pending there.
