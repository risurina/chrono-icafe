# Consolidate the "Customers" settings page into "Members" (Players)

**App:** chrono (`apps/chrono-api` + `apps/chrono-web`) — no `packages/agora` changes.

## Context

Chrono has two separate admin surfaces that both manage rows in the same
underlying `tenantMember` table:

- **Customers** (`/admin/settings/customers`, backed by `/rpc/customers` in
  `apps/chrono-api/src/routes/rpc.ts:1170-1385`) — a generic surface Chrono
  inherited unmodified from the `apps/agora-api`/`apps/agora-web` reference
  scaffold (it still exists there too, and stays there unchanged). Full CRUD:
  create (temp password), edit name/email, suspend/reactivate, export (DSAR),
  delete.
- **Members** ("Players" in the UI, `/admin/members`, backed by
  `/rpc/member-profiles`, `apps/chrono-api/src/modules/member/routes.ts`) —
  Chrono's own richer workflow on top of `chronoMemberProfile` (extends
  `tenantMember`): membership applications (approve/reject), invite, edit
  phone.

Today staff have to bounce between the two (the Members page even links out
to Customers per row, `members/page.tsx:326-331`, "Account"). The developer
wants one page: remove Customers, fold its actions into Members.

**The catch, and the resolved design decision:** Members' list query
(`member/routes.ts:196-230`) `INNER JOIN`s `chronoMemberProfile` with
`tenantMember`, so it only shows rows that have a profile. Two paths create a
bare `tenantMember` row with **no** `chronoMemberProfile`: the foundation's
global-customer "apply to tenant" flow (`agora/customer-auth`, business-neutral
— it can't know about Chrono's extension table) and Customers' own "Create"
action (`rpc.ts:1221`, no profile insert). The developer confirmed: the merged
page must **show every `tenantMember` linked to the tenant**, profile or not —
so the list query changes to a `LEFT JOIN`, and profile-only actions
(Approve/Reject/Edit phone) simply don't render for a profile-less row.

## Approach

Keep `/rpc/customers`' mutation routes exactly as they are (permission gates,
audit, business logic all untouched) — only their UI moves. Only the
**list** route changes, and only in `member/routes.ts` (Members' own list),
to surface every `tenantMember`.

### Phase 1 — Backend: LEFT JOIN + DTO for the Members list

**Files:**
- `apps/chrono-api/src/modules/member/routes.ts` (`GET /` and the
  `MemberProfileListItem` type, ~line 154-230) — restructure the query to
  `.from(base.tenantMember).leftJoin(chronoMemberProfile, eq(chronoMemberProfile.memberId, base.tenantMember.id))` (both the `count()` and the row select), keyed by `base.tenantMember.id`,
  reusing `withTenant` unchanged (RLS already forces isolation on both
  tables regardless of join direction — no `rls:proof` impact).
- `MemberProfileListItem`: rename its `id` to `memberId` (`tenantMember.id`,
  always present) and add `profileId: string | null` (`chronoMemberProfile.id`);
  make `phone`, `applicationStatus`, `appliedAt`, `approvedAt`, `rejectedAt`
  all nullable; add `status: "active" | "disabled"` from `tenantMember.status`
  (needed so the merged UI can render Suspend/Reactivate — mirror the enum
  Customers already uses, `branch/contracts.ts`'s `status` pattern, not a new
  literal). `createdAt` falls back to `tenantMember.createdAt` when there's no
  profile row.
- Sort keys (`appliedAt`/`createdAt`) must tolerate a null `appliedAt` — sort
  by `tenantMember.createdAt` when the requested sort column would be null
  (or just always sort on `tenantMember.createdAt`/`name` — check what the
  Members page's `useListQuery` actually requests before deciding; don't
  invent a third sort key that has no caller).
- `.get("/pending-count")` is unaffected (it only ever counted profiled rows).
- Remove the now-unused `.get("/customers", ...)` list route in
  `apps/chrono-api/src/routes/rpc.ts` (~line 1170-1211) — its only caller was
  the page being deleted in Phase 2. Leave every other `/customers/*` route
  (`POST`, `PATCH /:id`, `POST /:id/suspend`, `/reactivate`, `GET /:id/export`,
  `DELETE /:id`) untouched; the merged Members page becomes their new caller.
  Do **not** touch `apps/agora-api` — its own `/customers` list route still
  backs the scaffold's own Customers page, which is out of scope here.

**Acceptance criteria:**
- `GET /rpc/member-profiles` returns one row per `tenantMember` for the
  tenant, including one created via `POST /rpc/customers` with no profile
  (`profileId: null`, `applicationStatus: null`).
- `GET /rpc/customers` (list) no longer exists in `chrono-api`; the five
  mutation routes under `/customers/*` still work unchanged.
- No schema/migration/RLS change; `rls:proof` not required by this phase's
  own rules, but run it anyway since it's cheap and this touches a query
  shape (belt-and-suspenders, not because the isolation policy changed).

**Verification:** `pnpm --filter @agora/chrono-api typecheck`.

### Phase 2 — Frontend: merge the pages, remove the old one

**Files:**
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/members/page.tsx` — add,
  per row: Edit (name/email), Suspend/Reactivate (toggle off
  `member.status`), Export, Delete — each calling the same
  `api.rpc.customers[...]` endpoints `CustomersSettingsPage` already calls
  (`apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/customers/page.tsx`,
  being deleted — copy its handler bodies, don't rewrite them from scratch).
  Gate each with `<Can permissions={me.permissions} resource="customer" action="...">`
  (mirrors the existing `<Can resource="memberProfile" action="invite">` on
  this same page) — visibility only, server still enforces via the unchanged
  `requirePermission(..., { customer: [...] })` gates. Add a "Create customer"
  entry point (same form fields: email/name/temp password) reusing the
  existing `createCustomer` handler body. Approve/Reject render only when
  `profileId && applicationStatus === "pending"`; Edit phone only when
  `profileId` is set (a profile-less row has no `chronoMemberProfile.phone`
  to edit — explicitly out of scope, see below). Remove the per-row "Account"
  link (`members/page.tsx:326-331`) — its destination no longer exists.
- Delete `apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/customers/`
  (the whole directory — `page.tsx` is the only file in it).
- `apps/chrono-web/src/components/settings-nav.tsx` (~line 105-111) — remove
  the "Customers" `SETTINGS_SECTIONS` entry.
- Rename `MembersPage`'s `Member` type analogously to Phase 1's DTO
  (`memberId`, `profileId`, `status`, nullable profile fields) — one shape,
  no drift between what the route returns and what the page expects.

**Out of scope:**
- No change to the scaffold's own Customers page/nav
  (`apps/agora-web`/`apps/agora-api`) — it has no member-profile module of
  its own, so it keeps the pattern this plan is retiring only for Chrono.
- No lazy-create-a-profile-on-edit-phone affordance for profile-less rows —
  they simply don't get that action. A future "start tracking this customer
  as a player" action is separate follow-up work, not this plan.
- No permission/resource changes — `customer` and `memberProfile` stay two
  distinct permission resources exactly as today; only their UI surfaces
  merge.

**Verification:** `pnpm --filter @agora/chrono-web typecheck` and `pnpm --filter @agora/chrono-web build`; manual check of `/admin/members` for all six action types across a profiled and a profile-less row.

### Phase 3 — E2E: repoint and extend coverage

**Files:**
- `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts` (3
  occurrences of `/admin/settings/customers`, lines 65, 74, 89) — repoint to
  `/admin/members`. This is the real proof the LEFT JOIN fix works: today
  this spec's applied customer has no `chronoMemberProfile` row, so it
  currently could not have appeared on `/admin/members` at all.
- `apps/chrono-web/e2e/tests/members/members.spec.ts` and
  `.../members/invite-customer.spec.ts` — read both fully and re-run;
  they exercise only profiled rows (portal self-signup, staff invite), so
  they should pass unchanged, but confirm no selector assumed the old `id`
  (now `memberId`)/list shape.
- New assertion (in `members.spec.ts` or a new spec under
  `apps/chrono-web/e2e/tests/members/`): create a customer via the merged
  page's "Create customer" form → row appears with no application-status
  badge and no Approve/Reject/Edit-phone buttons, but Edit/Suspend/Export/
  Delete all work — this is the one genuinely new behavior this plan adds
  (`.ai/rules/e2e-testing.md` requires coverage for it).

**Acceptance criteria:**
- `apply-for-tenant.spec.ts` passes against `/admin/members`.
- The new profile-less-row scenario passes.
- No existing Members/Customers-adjacent spec regresses.

**Verification:** `pnpm --filter @agora/chrono-web e2e -- members` and
`-- global-customers` (per `.ai/rules/rbac.md`/e2e config: headed, needs
`pnpm dev` already running).

## Out of scope (whole plan)

- No schema, migration, or RLS change.
- No new permission resource or action.
- `apps/agora-api`/`apps/agora-web` (the reference scaffold) are untouched.
- The unrelated "Main branch auto-provisioning silently fails on
  `isurina.chrono2.izur.com.ph`" investigation from earlier in this session
  is separate follow-up, not part of this plan.

## Plan closure

Once all three phases land and verify, move this from `active/` to
`.ai/plans/chrono/archive/customers-members-merge/README.md`
(`.ai/rules/feature-planning.md`).
