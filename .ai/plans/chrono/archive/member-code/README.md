# Chrono — member code

**Sessions:** Planning: agora-90 [979a1b]
Implementation: <this-session>

## What this is

The member profile page (`/member/profile`) currently omits a "Member Code" —
oikos's own version shows a prominent staff-facing code approved members show at
the counter. Chrono has no equivalent today: `ChronoMemberProfiles` has no such
column. This plan adds one, generated automatically the moment a membership
application is approved, and surfaces it everywhere the profile already flows
(staff list/detail, the member's own portal read, the profile page UI).

## Pass 1 — Workflow Analysis

- **Who uses it:** the approved member (sees their own code on `/member/profile`,
  shows it to staff), and staff (see it on the member list/detail while serving a
  customer at the counter).
- **Workflow:** a membership application is approved (existing
  `POST /rpc/members/:memberId/approve` staff action) → a code is generated and
  stored atomically with the approval → the member's own `/member/profile` and
  staff's member list/detail both show it going forward.
- **Failure cases:** a code-generation collision (two approvals racing into the
  same random code) must not silently overwrite another member's code — retried
  with a fresh random value, not surfaced to the user as an error. A
  never-approved member has `memberCode: null` — the UI must show a "Not
  assigned" state, never fabricate one.
- **No new audit/notification**: this is a side-effect of the existing "approve"
  action, which is already audited (`chronoMemberProfile.approved`). No separate
  audit event.

## Pass 2 — Technical Planning

- Column lives on `ChronoMemberProfiles` (Chrono's own extension table), not the
  foundation's `TenantMembers` — per `.ai/rules/business-app.md`'s "reuse the
  foundation's end-customer pool, extend it, never fork it" and the naming rule
  (business data stays on the business app's own prefixed table).
- Generation: 6-character uppercase alphanumeric, excluding visually ambiguous
  characters (`0`/`O`, `1`/`I`/`L`) — a small `generateMemberCode()` helper in
  `apps/chrono-api/src/modules/member/service.ts`, called from
  `approveMemberProfile()` only when the row doesn't already have one (an
  already-approved row re-approved is a 409 today, so this is effectively
  "generate once, on the first approval"). On a unique-constraint collision,
  retry with a fresh code up to 5 times before giving up with a 500 — a
  same-request retry loop, not a background job.
- Uniqueness is per-tenant (`uniqueIndex` on `(tenantId, memberCode)`) — Postgres
  unique indexes already permit multiple `NULL`s, so no partial-index trick is
  needed for never-approved members.
- `toMemberProfile()` (the one DTO mapper both staff and portal routes already
  share) gains `memberCode: string | null` — this automatically flows to
  `GET /rpc/members` (staff list), `GET /rpc/members/:memberId` equivalents, and
  `GET /portal/members/me` (the member's own read) with no route-level changes
  beyond the mapper and its row type.
- Web: `MemberProfile` type in `apps/chrono-web/src/lib/member/account.ts` gains
  `memberCode: string | null`; the profile page's hero shows it (mirroring
  oikos's prominent display) only when `approved && profile?.memberCode`,
  "Not assigned" otherwise — never fabricated.
- Tenant/role/RLS impact: none beyond the existing `ChronoMemberProfiles` RLS
  policy (already forced, already in `APP_TENANT_TABLES`) — this is a column
  addition to an existing tenant-scoped table, not a new table.

## Files to Update

- `apps/chrono-api/src/modules/member/schema.ts` — add `memberCode` column +
  unique index.
- `apps/chrono-api/src/modules/member/service.ts` — `generateMemberCode()` +
  wire into `approveMemberProfile()`.
- `apps/chrono-api/src/modules/member/contracts.ts` — `memberCode` on
  `memberProfileDtoSchema` / `MemberProfileRow` / `toMemberProfile()`.
- `apps/chrono-web/src/lib/member/account.ts` — `memberCode` on `MemberProfile`.
- `apps/chrono-web/src/app/(member-area)/member/profile/page.tsx` — display it in
  the hero, "Not assigned" fallback.
- A new Drizzle migration (generated, not hand-written) under
  `apps/chrono-api/src/database/migrations/`.
- `apps/chrono-web/e2e/tests/member/profile-settings.spec.ts` — extend the happy
  path to assert a code appears after a staff approval (the existing signup
  helper only gets a member to "pending"; this needs a staff approve step added
  to the flow, or a new small spec if that's cleaner — implementer's call).

## Step-by-Step Tasks

1. Add the column + index to `schema.ts`.
2. `pnpm db:generate --name chrono_member_profile_add_member_code` then
   `pnpm db:migrate`.
3. Add `generateMemberCode()` and wire it into `approveMemberProfile()` with the
   retry-on-collision loop.
4. Update `contracts.ts` (`toMemberProfile`, DTO schema, row type).
5. Update the web `MemberProfile` type and the profile page's hero display.
6. Update/add the e2e coverage.
7. Run verification commands below.

## Acceptance Criteria

- Approving a pending application assigns a unique, non-null `memberCode` to
  that tenant's `ChronoMemberProfiles` row.
- The member's own `/member/profile` shows the code once approved; a
  pending/rejected/never-applied member sees "Not assigned", never a fabricated
  value.
- Staff's existing member list/detail routes return `memberCode` with no other
  behavior change.
- Two tenants can independently have a member with the same-looking code with
  no cross-tenant collision (uniqueness is per-tenant, not global).

## Verification Commands

- `pnpm typecheck`
- `pnpm --filter @agora/api rls:proof` (re-run after any schema change, even a
  column addition to an already-RLS'd table)
- The updated/new e2e spec, run against a real dev server per
  `.ai/rules/e2e-testing.md`

## Out of Scope

- Letting staff manually edit/reassign a code (this pass is generate-on-approval
  only).
- Any QR/barcode encoding of the code (oikos has no such feature on this page
  either).
- Reusing a code after a member is rejected then re-applies-and-is-approved
  again (out of scope: a fresh `applyForMembership()` after rejection reuses the
  same row per the existing idempotent-apply behavior, so this is the same "only
  generate when absent" rule already covers it).

## Execution Start Point

Start at `apps/chrono-api/src/modules/member/schema.ts` — add the column, then
follow the Step-by-Step Tasks in order.

## Closure

Implemented and verified: `pnpm typecheck` (all packages), `pnpm --filter
@agora/api rls:proof` (PASS), the `test:member-concurrency` guard test
(9/9), and the extended `profile-settings.spec.ts` e2e spec run against
real dev servers (2/2 passing). Migration
`apps/chrono-api/drizzle/0031_chrono_member_profile_add_member_code.sql`
applied. No deviations from scope.
