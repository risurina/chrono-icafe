# Chrono Member Lounge — Richer Detail (Wallet, Time Credits per Station, Membership)

**Sessions:**
- Planning: current session
- Audit: (unclaimed)
- Implementation: (unclaimed)

## Source

Developer ask: the member portal home (`{tenantSlug}.APP_DOMAIN/member`, "My Lounge") feels
thin — wants more detail, wallet balance, and time credits broken out per PC/station, plus
membership status/member code/member-since. A related but separate ask (the platform-wide
`(saas-member)/member` dashboard being "boring") is explicitly **out of scope** here — that
surface lives in the `agora` foundation, not `chrono`, and needs its own plan under
`.ai/plans/agora/`.

## Pass 1 — Workflow Analysis

- **Who uses this**: a `tenantMember` with a `ChronoMemberProfiles` row — visitor, pending
  applicant, or approved member. All three land on `/member` today.
- **Workflow**: on load, the page already fetches session summary, wallet balance, loyalty,
  credit products, and the member's own reservation in parallel, and renders a stack of
  cards. The ask adds two things to that stack: (1) the member's own `memberCode` (data
  already fetched into `member-area-context`'s `profile`, just never rendered on this page),
  and (2) a per-station-group breakdown of the member's own remaining time credits (data
  exists in `ChronoCreditGrants`/`GET /portal/credits/balance`, but the DTO doesn't carry
  which station group a grant is scoped to, so the page can't group by "PC"/station today).
- **Failure cases**: pending/rejected applicant must keep seeing the existing status card and
  must NOT see wallet/time-credits (mirrors the existing `approved` gate already used for the
  Wallet and Membership cards); a member with zero credit grants sees an honest empty state,
  not a fabricated "0 minutes" per group; cross-tenant isolation — a member must only ever see
  their own grants for their own tenant (already enforced by `withTenant` + `memberMiddleware`,
  unchanged by this plan).
- **No new audit/notification needed** — this is a read-only surface.

## Pass 2 — Technical Planning

**Existing, reusable (confirmed by direct code read, not memory):**

- `apps/chrono-web/src/app/(tenant-member)/player/page.tsx` — the Lounge page. Already shows:
  playtime hero, wallet balance, loyalty tier + "Member since" (`loyalty.memberSince`),
  pending/rejected status card, premium store strip. Gate variable `approved` and `profile`
  (with `profile.memberCode`) already come from `useMemberArea()`
  (`apps/chrono-web/src/components/member/member-area-context.tsx`) — no new fetch needed for
  member code.
- `GET /portal/credits/balance` (`apps/chrono-api/src/modules/credit/portal-routes.ts`) already
  returns the member's own `ChronoCreditGrants` with `remainingQuantity`/`expiresAt`, via
  `toPortalCreditGrantDto` (`apps/chrono-api/src/modules/credit/contracts.ts:132-173`). The
  chrono-web client `getMyCreditBalance()` (`apps/chrono-web/src/lib/member/credits.ts`) already
  calls it end-to-end.
- **Gap**: `PortalCreditGrantDto` does not expose `stationGroupId` (present on the underlying
  `ChronoCreditGrants` row, `apps/chrono-api/src/modules/credit/schema.ts:42`) or a resolved
  group name, so the page has no way to group "time credits" by PC/station today.

**Map of work:**

- `apps/chrono-api` — extend one DTO + its mapping function + the `/balance` handler to resolve
  station-group names. No schema change, no migration, no new table.
- `apps/chrono-web` — extend one client type, then edit the Lounge page to render member code
  and a new "Time Credits" card grouped by station group.
- No RLS/tenant-isolation change — reads stay on the existing `withTenant`-scoped queries. Not
  a schema/migration change, so `rls:proof` is not mandated by `.ai/rules/database.md`, but the
  new station-group lookup is still a tenant-scoped read and is written through `withTenant`
  like everything else in this module.

**Out of scope**: the platform-wide `(saas-member)/member` dashboard (separate `agora`-scoped
plan); new schema/migration; loyalty logic changes; wallet top-up/checkout flow changes;
live per-PC occupancy/availability (that's `/stations`, a different page, not the Lounge home);
any change to `applicationStatus` enforcement itself (already correct, per `member-approval-guard`).

## Phase 1 — Backend: expose station-group scope on portal credit grants

**Files to Update:**
- `apps/chrono-api/src/modules/credit/contracts.ts` — add `stationGroupId: z.string().nullable()`
  and `stationGroupName: z.string().nullable()` to `portalCreditGrantDtoSchema`; extend
  `CreditGrantRow` with `stationGroupId: string | null`; update `toPortalCreditGrantDto` to
  accept an optional `stationGroupName` (or a lookup map) and populate both fields.
- `apps/chrono-api/src/modules/credit/portal-routes.ts` — in the `GET /balance` handler, after
  loading the member's own grants (`withTenant`), select the tenant's `ChronoStationGroups`
  `(id, name)` once and build an `id -> name` map; pass each grant's `stationGroupId` through
  the map (a strict-group grant's `stationGroupId` is never null per its own CHECK; an
  any-station grant's is null → render as `null`, which the frontend renders as "Any station").

**Step-by-Step Tasks:**
1. Read the exact current `GET /balance` handler body in `portal-routes.ts` and the
   `chronoStationGroup` import path used elsewhere in this module (`routes.ts` already imports
   it for `requireOwnStationGroup`) to match the existing query style.
2. Add the two nullable fields to `portalCreditGrantDtoSchema` and `CreditGrantRow`.
3. Update `toPortalCreditGrantDto`'s signature to also take `stationGroupId` (from the row) and
   a resolved `stationGroupName` (from the map built in the route handler) — keep the function
   pure (no query inside `contracts.ts`); the route resolves names before mapping.
4. Update every other call site of `toPortalCreditGrantDto` (`purchase`, the two other spots in
   `portal-routes.ts` found in the grep) to pass through `stationGroupId`/resolved name
   consistently — a purchase's resulting grant should show its group immediately too.

**Acceptance Criteria:**
- `GET /portal/credits/balance` response items include `stationGroupId` (string or null) and
  `stationGroupName` (string or null, `null` = any-station).
- `POST /portal/credits/purchase`'s returned `grant` also carries both fields.
- Existing consumers of the old (narrower) DTO shape are unaffected (additive fields only).

**Verification Commands:**
- `pnpm --filter @agora/chrono-api typecheck` (or workspace-wide `pnpm typecheck`)
- Existing credit module tests: `pnpm --filter @agora/chrono-api test` (covers
  `concurrency.test.ts` and any credit contract tests) — must still pass unmodified.

**Out-of-Scope:** changing grant-eligibility scoring (`service.ts`'s `scoreGrantEligibility`),
adding a staff-facing view of this, any new route.

## Phase 2 — Frontend: render member code, member-since, and time credits per station

**Files to Update:**
- `apps/chrono-web/src/lib/member/credits.ts` — extend the local `CreditGrant` type with
  `stationGroupId: string | null` and `stationGroupName: string | null`, matching Phase 1's DTO.
- `apps/chrono-web/src/app/(tenant-member)/player/page.tsx`:
  - Fetch `getMyCreditBalance()` (already exists in `credits.ts`) alongside the existing
    `Promise.all([...])` load, only when `member` is set (guest/pending gating unchanged).
  - Membership card: render `profile.memberCode` (from `useMemberArea()`) as a small label/
    badge next to the existing tier badge, e.g. "Code: ABC-1234", only when `approved &&
    profile?.memberCode`. Keep the existing "Member since {loyalty.memberSince}" line as-is —
    it already satisfies "member since".
  - Add a new `data-testid="time-credits-card"` `Card` (placed after the Wallet/Membership
    `Grid`, before the Premium store strip) that, when `approved`:
    - groups `grants` (status `"granted"` only) by `stationGroupName ?? "Any station"`,
    - for each group renders the summed `remainingQuantity` (via `formatMinutes`) and the
      soonest `expiresAt` in that group (if any),
    - shows an empty state ("No active time credits — visit the store below.") when there are
      zero granted-status grants,
    - is entirely absent (not just empty) when `!approved`, matching the Wallet/Membership
      pattern already used for gating.
  - Keep all cards as inline JSX in `page.tsx`, matching the file's existing convention (no new
    component files) — this repo's CLAUDE.md rule against unneeded abstraction applies; do not
    extract a new component for one card when every existing card is already inline here.

**Acceptance Criteria:**
- Approved member with at least one active grant sees a "Time Credits" card listing one row per
  station group (or "Any station") with remaining minutes and expiry.
- Approved member with zero active grants sees the card with its empty state, not a crash or a
  blank grid.
- Pending/rejected/guest member sees no "Time Credits" card, no wallet balance, no member code —
  unchanged from current behavior for those states.
- Member code renders next to the tier badge for an approved member who has one; renders
  nothing extra (not "Code: null") when `memberCode` is null.

**Verification Commands:**
- `pnpm --filter @agora/chrono-web typecheck` (or workspace-wide `pnpm typecheck`)
- Manual check via `pnpm dev`: sign in as an approved member with a purchased credit product,
  confirm the new card renders correctly; sign in as a pending applicant, confirm it's absent.

**Out-of-Scope:** a dedicated "time credits" detail/history page (ledger already exists at
`/member/wallet` history — not duplicated here), editing/managing credits from this page.

## Phase 3 — E2E

**Files to Update:**
- `apps/chrono-web/e2e/tests/member/dashboard.spec.ts` — extend the existing happy-path test to
  also assert `time-credits-card` is visible for an approved member with a purchased grant and
  shows the expected station-group label + remaining minutes; extend the existing role-gate
  test (pending applicant) to assert `time-credits-card` is absent; extend the existing
  cross-tenant isolation test to assert a member's `GET /portal/credits/balance` never surfaces
  another tenant's station-group names.

**Acceptance Criteria:** spec passes headed against a running `pnpm dev`, per
`.ai/rules/e2e-testing.md`'s manual-run convention for this suite.

**Verification Commands:**
- `pnpm dev` (both apps running)
- Run `apps/chrono-web/e2e/tests/member/dashboard.spec.ts` via Playwright, headed.

**Out-of-Scope:** new standalone spec file — this extends the existing dashboard spec, since the
feature is additive to an already-covered page.

## Execution Start Point

Phase 1, starting with reading the current full body of `apps/chrono-api/src/modules/credit/
portal-routes.ts`'s `GET /balance` handler and `apps/chrono-api/src/modules/station/schema.ts`'s
`chronoStationGroup` table (`id`, `name` columns) to confirm the exact query shape to copy.
