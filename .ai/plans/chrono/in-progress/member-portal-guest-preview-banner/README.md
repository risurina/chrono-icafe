# Chrono — banner instead of blocking screen for not-yet-applied / pending members

**Type:** UI workflow change to `apps/chrono-web`'s member portal gating. No schema
change. No new tenant-scoped tables.

**Sessions:**
- Planning: (this session)
- Audit: (unclaimed)
- Implementation: (subagent, no persistent session name)

## Reported request (verbatim intent)

On tenant hosts, `/member/*` currently full-page-blocks two states:

1. A signed-in **global customer** who hasn't applied to this tenant yet →
   `ApplyForTenantPrompt` ("Join this business… Apply") replaces the entire page.
2. A `tenantMember` whose Chrono `applicationStatus` is still `pending` → blocked from
   `/member/promos` specifically by `ApprovalRequiredCard` (via `RouteGate`'s
   `requiresApproval` flag).

The developer wants both replaced by a **non-blocking banner** shown across every
`/member/*` page, with the underlying pages (nav, promos, rates/session info, etc.)
visible behind it — not a full takeover screen.

**Confirmed scope decisions** (from developer Q&A this session):
- All member-area nav pages render their normal Chrome (header + nav) for both states;
  each page decides for itself how to handle missing member data, rather than one
  global page swap.
- Pending members: same banner treatment as not-yet-applied.
- Not-yet-applied global customers: **they must register (apply) to interact** — pages
  are visible/browsable but interactive/live member data is locked behind a "sign up to
  unlock" affordance, not real live data. No auto-apply-on-visit, no new public/no-auth
  API. This is the deliberately smallest-footprint of the three options discussed.

## What investigation found

- `MemberGate` (`apps/chrono-web/src/components/member/member-gate.tsx:104-162`) computes
  `canApply = bothResolved && !member && !!globalCustomer` and returns
  `<ApplyForTenantPrompt />` **instead of** `Chrome` when true (line 140-142) — a full
  takeover, no nav, no page content.
- `RouteGate` (`member-gate.tsx:42-51`) renders `<ApprovalRequiredCard>` instead of
  `children` when the matched `MEMBER_NAV` entry has `requiresApproval: true` and the
  member isn't `approved` — today only `promos` carries that flag
  (`member-nav.config.ts:73-82`).
- Server-side (confirmed by research): `GET /portal/promos`
  (`apps/chrono-api/src/modules/promo/portal-routes.ts`) and
  `GET /portal/credits/products` (`apps/chrono-api/src/modules/credit/portal-routes.ts`)
  both gate on `memberMiddleware()` only — i.e. a real, `status: "active"` `tenantMember`
  row. `applicationStatus` (Chrono's own `pending`/`approved`/`rejected`, on
  `chronoMemberProfile`) is **not** enforced server-side anywhere on these routes — it's
  pricing-only (`memberRateEligible`). So:
  - A **pending** `tenantMember` can already fetch real promos/credits data today — the
    only current blocker is `RouteGate`'s client-side check. Fixing their case is a pure
    UI change (remove the block, add the banner).
  - A **not-yet-applied** global customer has **no `tenantMember` row at all** →
    `memberMiddleware()` 401s any `/portal/*` call. Per the confirmed decision, this is
    intentional: their pages must render, but the actual data-fetching parts must know
    not to call member-only endpoints, and show a "sign up to unlock" lock-state instead.
- `MemberAreaProvider` (`member-area-context.tsx:27-56`) requires a non-null `member`
  prop and eagerly fetches `/portal/members/me` + `/me/onboarding` on mount — cannot be
  mounted at all for the not-yet-applied case today.
- `MemberHeader` (`member-header.tsx:16-58`) requires a non-null `member: MemberUser`
  (reads `.name`/`.email` for `IdentityMenu`) — same blocker.
- `useGlobalCustomerSession()` (`agora/client/react`, re-exported from
  `apps/chrono-web/src/lib/customer-client.ts:16`) already gives a `GlobalCustomerUser`
  (name/email) for the not-yet-applied case — enough identity info to render a header
  without a `tenantMember`.

## Pass 1 — Workflow analysis

**Who:** (a) a signed-in global customer who has not yet applied to this tenant; (b) a
`tenantMember` whose Chrono application is `pending`; (c) staff, unaffected.

**Workflow after this change:**
- (a) visits any `/member/*` route → sees the normal Chrome (header shows their global
  customer name, nav renders) with a **"Join this business"** banner pinned above the
  page content. Page content itself renders its normal layout, but any section that
  needs real member data (wallet balance, promos list, reservations, history rows, etc.)
  shows a small locked/teaser state ("Apply to unlock this") instead of attempting the
  member-only API call. Clicking the banner's Apply button performs the existing
  `applyForTenantMembership()` + `applyForMembership()` flow (unchanged plumbing, per
  `member-apply-profile-autocreate`), then reloads into the fully unlocked portal.
- (b) visits any `/member/*` route → sees the normal Chrome with an **"Application
  pending"** banner, and full access to every page's real data (this already works
  server-side; only the client block is removed).

**Failure cases:**
- Both session resolvers still pending → unchanged skeleton (`Loading…`).
- Neither member nor global customer → unchanged redirect to `/login?next=…`.
- A not-yet-applied guest's browser somehow calls a member-only endpoint directly
  (e.g. a stale tab) → existing 401 handling; the new lock-state components must treat a
  401/no-member case as "not unlocked", not as an error toast.
- Cross-tenant: unaffected — no new tenant-scoped data path, no schema change.

**Audit / notifications:** none — no new mutating action, no schema.

## Pass 2 — Technical planning

**No DB/RLS/schema change.** This is a client-side gating + presentation change in
`apps/chrono-web` only, following the existing `member`/`globalCustomer` session
resolvers.

### New shared pieces

1. **`MemberAccessBanner`** (new,
   `apps/chrono-web/src/components/member/member-access-banner.tsx`) — a slim, full-width
   bar (not a takeover `Card`), two variants:
   - `variant="not-applied"`: "Join this business — apply to become a customer to
     unlock your account." + an `Apply` button.
   - `variant="pending"`: "Your membership application is pending approval." (read-only,
     reuses `NeedHelpLinks` inline if useful).
   Reuses the existing `applyForTenantMembership()` + `applyForMembership()` +
   `track(...)` + `location.reload()` sequence from
   `apply-for-tenant-prompt.tsx:18-38` — extract that into a small
   `useApplyForTenant()` hook in the same file (or a new
   `apps/chrono-web/src/lib/member/use-apply-for-tenant.ts`) so both the banner and the
   existing full-card `ApplyForTenantPrompt` (still used by the landing page's
   `PlayerCtaActions` — out of scope, keep it working unchanged) share one
   implementation instead of duplicating the apply sequence.

2. **`RequiresMembership`** (new,
   `apps/chrono-web/src/components/member/requires-membership.tsx`) — a small wrapper:
   `{ member: MemberUser | null; children: React.ReactNode; fallback?: React.ReactNode }`.
   Renders `children` when `member` is non-null, else a default compact locked card
   ("Apply to unlock this") or the given `fallback`. Pages use this around the parts of
   their content that call member-only APIs — see Phase 2.

### `MemberGate` / `Chrome` changes

- `canApply` no longer returns early with `<ApplyForTenantPrompt />`. Instead it flows
  into a **guest-mode** render of `Chrome`:
  - `Chrome` gets a new optional prop shape: `member: MemberUser | null` (was
    non-null-implied via `MemberAreaProvider`).
  - `MemberAreaProvider` is changed to accept `member: MemberUser | null`; when `null`,
    it skips both `/me` fetches entirely (no point calling endpoints that will 401),
    and exposes `member: null, profile: null, onboarding: null, approved: false,
    loaded: true` immediately.
  - `MemberHeader` accepts an identity shape instead of a hard `MemberUser`:
    `identity: { name: string; email: string } | null`. `MemberGate` passes either the
    real `member` or the `globalCustomer` (name/email) for guest mode. When identity is
    null (shouldn't happen once past the `!member && !globalCustomer` redirect, but keep
    it defensive), fall back to a generic label.
  - `Chrome` renders `<MemberAccessBanner variant="not-applied" />` above
    `<RouteGate>{children}</RouteGate>` when in guest mode, or
    `variant="pending"` when `onboarding?.applicationStatus === "pending"` (computed
    once `MemberAreaProvider` has `loaded`).
- `RouteGate` (`member-gate.tsx:42-51`): remove the `ApprovalRequiredCard` full-block
  branch entirely — a pending member's `requiresApproval` routes now just render
  `children` (the banner above already communicates status). `ApprovalRequiredCard` and
  the `requiresApproval` flag on `MEMBER_NAV` become dead — delete both rather than
  leaving unused gating code (per repo's no-speculative-code rule); if a future route
  genuinely needs a hard per-route gate, that's a new, deliberate decision, not this one
  left lying around.

### Page-level guest handling (guest / `canApply` mode only — pending members are
already fully unlocked once the above lands)

Each of the 9 `MEMBER_NAV` pages under
`apps/chrono-web/src/app/(tenant-member)/player/*` reads `useMemberArea()` and must not
call a member-only endpoint when `member` is `null`. Concretely, per page:

| Page | File | Guest treatment |
|---|---|---|
| Dashboard | `player/page.tsx` | Wrap personal-stat cards (playtime, active reservation, wallet, membership) in `RequiresMembership`; tenant-level info (if any) stays visible. |
| Promos | `player/promos/page.tsx` | Explicitly called out by the developer — wrap the credit-packs grid and running-promotions list in `RequiresMembership` (skip the `getCreditProducts()`/`getActivePromos()` calls entirely when `member` is null, don't fire-then-catch-401). |
| Session | `player/session/page.tsx` | Wrap in `RequiresMembership` — session/rate info the developer mentioned ("rate etc") renders inside once real member context exists; for guests, show the locked state (per confirmed decision: visible but not interactive). |
| Reservations | `player/reservations/page.tsx` | `RequiresMembership` around the booking UI. |
| Wallet | `player/wallet/page.tsx` | `RequiresMembership` around balance/transactions. |
| History | `player/history/page.tsx` | `RequiresMembership` around the history list. |
| Profile | `player/profile/page.tsx` | `RequiresMembership` around editable profile fields. |
| Settings | `player/settings/page.tsx` | `RequiresMembership` around account settings. |
| Inquiries | `player/inquiries/page.tsx` | `RequiresMembership` around the inquiry form/list. |

This table is the concrete task list for Phase 2 — same mechanical pattern repeated,
good candidate for delegation once Phase 1 lands and the pattern is proven on Promos.

**Out of scope:**
- The landing page's `ApplyForTenantPrompt`/`PlayerCtaActions` full-card flow — stays as
  is (a signed-out or not-yet-a-customer visitor on the public landing page has no
  Chrome to put a banner into; this plan only touches the authenticated `/member/*`
  gate).
- Any new "public preview" API — explicitly rejected by the developer.
- Auto-apply-on-visit — explicitly rejected by the developer.
- Any change to `packages/agora`'s foundation apply route, `memberMiddleware()`, or
  RLS/tenant isolation.
- The `member-apply-profile-autocreate` in-progress plan's own scope (wiring the Chrono
  apply call into `onApply()`) — that plan's `useApplyForTenant()` extraction target
  should be coordinated so the two don't conflict; check its status before starting
  Phase 1 here.

## Phase 1 — Banner + guest-mode Chrome, remove the two full-page blocks

**Files to update**
- `apps/chrono-web/src/components/member/member-gate.tsx`
- `apps/chrono-web/src/components/member/member-area-context.tsx`
- `apps/chrono-web/src/components/member/member-header.tsx`
- `apps/chrono-web/src/components/member/member-nav.config.ts` (drop `requiresApproval`)
- `apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx` (extract shared hook)
- New: `apps/chrono-web/src/components/member/member-access-banner.tsx`
- New: `apps/chrono-web/src/lib/member/use-apply-for-tenant.ts` (or co-located in
  `apply-for-tenant-prompt.tsx` if that reads cleaner — implementer's call)
- Delete: `ApprovalRequiredCard` (inline in `member-gate.tsx`, remove with `RouteGate`
  simplification)

**Step-by-step tasks**
1. Extract `onApply()` from `apply-for-tenant-prompt.tsx` into `useApplyForTenant()`
   returning `{ applying, apply }`; `ApplyForTenantPrompt` uses it unchanged (no visible
   behavior change to the landing-page path).
2. Build `MemberAccessBanner` using the hook, two variants as specified above.
3. Change `MemberAreaProvider` to accept `member: MemberUser | null`; guard both fetches
   and the returned `approved`/`onboarding` behind `member !== null`.
4. Change `MemberHeader` to accept `identity: { name: string; email: string }` instead
   of `member: MemberUser` (or keep the prop name `member` but loosen its type — pick
   whichever keeps the diff smaller).
5. In `MemberGate`: drop the early `if (canApply) return <ApplyForTenantPrompt />`
   branch. Always render `Chrome`, passing whichever identity is available
   (`member ?? globalCustomer`) and a `guestMode: boolean` (= `canApply`) flag down to
   `MemberAreaProvider`/`Chrome`.
6. In `Chrome`: read `approved`/`onboarding`/`loaded` from `useMemberArea()` and render
   the correct `MemberAccessBanner` variant (`not-applied` when `guestMode`, `pending`
   when `loaded && onboarding?.applicationStatus === "pending"`, none otherwise) above
   `<RouteGate>`.
7. Simplify `RouteGate` to just `return <>{children}</>` (or remove the component
   entirely and inline `children` at the call site) — delete `ApprovalRequiredCard`.
8. Remove `requiresApproval` from `MemberNavEntry`'s type and from the `promos` entry in
   `member-nav.config.ts`; update its comment block (lines 13-29) since it currently
   documents this exact mechanism.

**Acceptance criteria**
- A signed-in global customer with no `tenantMember` for this tenant, visiting any
  `/member/*` route, sees the normal header + nav + page shell with a "Join this
  business" banner — not a full takeover screen.
- A `tenantMember` with `applicationStatus: "pending"` visiting `/member/promos` sees
  the page render (no `ApprovalRequiredCard`), with a "pending" banner.
- An approved member sees no banner, unchanged behavior otherwise.
- No console errors from `MemberAreaProvider` attempting `/me` calls in guest mode.
- Landing page `ApplyForTenantPrompt`/`PlayerCtaActions` flow unchanged.

**Verification commands**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: `pnpm dev`, visit a tenant host as (1) a global customer who hasn't applied,
  (2) a pending tenantMember, (3) an approved member — confirm banner/no-banner per
  state.

**Out-of-scope:** page-level `RequiresMembership` wrapping (Phase 2) — Phase 1 leaves
guest-mode pages calling their existing data hooks, which will 401; that's expected and
fixed in Phase 2, not silently tolerated as "done" here.

## Phase 2 — Wrap member-only page content in `RequiresMembership`

**Files to update:** the 9 files listed in the Pass 2 table above, plus new
`apps/chrono-web/src/components/member/requires-membership.tsx`.

**Step-by-step tasks**
1. Build `RequiresMembership` per the spec above (default locked-state copy: "Apply to
   unlock this section", reusing `Card`/`CardContent` from `agora/ui`).
2. For each page: read `member` from `useMemberArea()`; when `null`, do not call the
   page's data-fetching functions (guard the `useEffect`/`load()` call), and wrap the
   real content JSX in `<RequiresMembership member={member}>`.
3. Start with `player/promos/page.tsx` (explicitly requested) and
   `player/session/page.tsx` ("rate etc") first, verify the pattern, then apply
   mechanically to the remaining 7 pages.

**Acceptance criteria**
- Guest mode: every `/member/*` page renders its shell + banner + a locked-state card
  in place of live data, with zero calls to member-only endpoints (check network tab —
  no 401s from `/portal/*` while in guest mode).
- Pending/approved members: unaffected, full data loads as today.

**Verification commands**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual pass over all 9 pages in guest mode + pending mode.

## Phase 3 — E2E coverage

**Files to update**
- `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts` (update any
  assertion that expects the old full-page `ApplyForTenantPrompt` inside `/member/*`)
- `apps/chrono-web/e2e/tests/global-customers/venue-status.spec.ts` (check for
  assumptions about the old blocking screens)
- `apps/chrono-web/e2e/tests/member/lounge-directory.spec.ts` (references
  `ApplyForTenantPrompt` flow — confirm still valid)
- New: a spec covering (a) guest sees banner + locked pages, (b) pending member sees
  banner + unlocked pages.

**Acceptance criteria:** existing specs pass with updated assertions; new spec added
covering both banner variants and the guest lock-state.

**Verification commands**
- `pnpm --filter @agora/chrono-web e2e -- global-customers`
- `pnpm --filter @agora/chrono-web e2e -- member`

## Execution start point

`apps/chrono-web/src/components/member/member-gate.tsx` — read the whole file (already
quoted above) side by side with `member-area-context.tsx` and `member-header.tsx` before
touching anything; Phase 1 changes all three together.

## Plan closure

Once all phases land and verify, move this plan from `draft/` → `ready/` →
`in-progress/` → `.ai/plans/chrono/archive/member-portal-guest-preview-banner/README.md`
per `.ai/rules/feature-planning.md`.
