# Chrono — "visitor" application status: view-only access before applying

**Type:** access-model change to `apps/chrono-api` (new status value + mutation gating) and
`apps/chrono-web` (member portal UI rework). No schema migration — `applicationStatus` is
a free-text column, not a Postgres enum.

**Sessions:**
- Planning: (this session)
- Audit: (unclaimed)
- Implementation: (subagent, no persistent session name)

## Supersedes / reworks

This plan revises behavior just shipped in `member-portal-guest-preview-banner`
(archived) — that plan's `RequiresMembership` locked an ENTIRE section per page when
`member === null`. This plan changes the model: a visit now creates a real `tenantMember`
+ `chronoMemberProfile` (status `"visitor"`) automatically, so `member` is non-null from
the first visit onward, and only genuinely mutating actions stay locked — reads (promos,
rates, wallet balance, reservation listings, history) become visible immediately.

## Confirmed decisions (developer Q&A this session)

1. **Visiting `/member/*` auto-creates a `"visitor"` row** — no click required. This
   explicitly reverses the earlier "must click Apply, nothing created on visit" rule;
   confirmed intentional so staff can see and invite site visitors.
2. **"Visitor" ≠ "applied."** The visitor row is not an application — clicking the
   existing **Apply** action later is what turns a `"visitor"` row into a real
   application (`"pending"`, or `"approved"` if the tenant auto-approves).
3. **Access split:** `pending` and `approved` keep full access (unchanged — this was
   already true server-side). `visitor` gets read access to everything, but is blocked
   from every mutating action.
4. **`inactive`/`blacklisted` are deferred**, per developer steer this session — not in
   scope for this plan. `applicationStatus` stays free-text so adding them later needs no
   further migration.

## What investigation found

- `chronoMemberProfile.applicationStatus` (`apps/chrono-api/src/modules/member/schema.ts:21`)
  is `text(...).notNull().default("pending")` — free text, currently `"pending" |
  "approved" | "rejected"` by convention only. Adding `"visitor"` is a code-level change,
  not a migration.
- **No mutating `/portal/*` route today checks `applicationStatus` at all** — every one is
  gated only by `memberMiddleware()` (any active `tenantMember`, regardless of Chrono
  application status). Full list (method, path, file:line):
  1. `POST /portal/members/apply` — `member/portal-routes.ts:137`
  2. `PATCH /portal/members/me` — `member/portal-routes.ts:181`
  3. `POST /portal/reservations/` — `reservation/portal-routes.ts:148`
  4. `POST /portal/reservations/queue` — `reservation/portal-routes.ts:172`
  5. `POST /portal/reservations/:id/confirm` — `reservation/portal-routes.ts:195`
  6. `POST /portal/reservations/:id/cancel` — `reservation/portal-routes.ts:211`
  7. `POST /portal/inquiries/` — `inquiry/portal-routes.ts:83`
  8. `POST /portal/inquiries/:id/reply` — `inquiry/portal-routes.ts:118`
  9. `POST /portal/credits/purchase` — `credit/portal-routes.ts:147`
  10. `POST /portal/payments/checkout` (covers wallet top-up) — `payment/portal-routes.ts:89`
  11. `POST /public/qr/consume` (starts a session; outside `/portal` but same actor) —
      `qr/public-routes.ts:240`
  - `POST /portal/customer/apply` (foundation, `packages/agora/src/identity/customer-auth/index.ts:1052`)
    is a **separate, lower layer** — it only creates the `tenantMember` row (instant
    access, by design) and is untouched by this plan; `chronoMemberProfile.applicationStatus`
    is explicitly documented there as "a separate layer on top."
- **Read-only `/portal/*` routes already need no change** — they were never gated on
  `applicationStatus`, so once a `"visitor"` row exists, promos, credit products (rates),
  wallet balance/history, reservation listings/availability, inquiries list, session
  summary, loyalty, and the activity feed all already return real data for any active
  `tenantMember`. The only thing currently hiding them is the client's blanket
  `RequiresMembership` wrap — a client-only fix for those.
- **`POST /portal/members/apply` is already idempotent** (`member/portal-routes.ts:137-177`)
  but in the wrong direction for this plan: calling it when a profile row already exists
  just returns the existing row unchanged — it does **not** transition `"visitor"` →
  `"pending"`. This route's existing-row branch needs new logic: if the existing status is
  `"visitor"`, promote it (respecting `chrono.autoApproveMembers`); any other existing
  status stays untouched exactly as today.
- **No route creates a `"visitor"` row today** — a new call path is needed for the silent
  first-visit registration (see Phase 1).
- **Staff UI needs no new surface.** `apps/chrono-web/src/app/(tenant-admin)/dashboard/members/page.tsx`
  already lists both `chronoMemberProfile`-backed and plain-customer rows in one table,
  already has an `applicationStatus`-driven `Badge` (line ~427-447) and an existing
  `Can resource="memberProfile" action="invite"` → "Invite player" action (line ~349-351).
  Adding `"visitor"` is a new badge-variant branch, not a new page.

## Pass 1 — Workflow analysis

**Who:** (a) a signed-in global customer visiting a tenant for the first time — becomes a
`"visitor"`; (b) that same customer later clicking Apply — becomes `"pending"`/`"approved"`;
(c) staff, who now see visitor rows in the existing Members list and can invite them.

**Workflow:**
- (a) visits any `/member/*` route → client silently registers them as a `"visitor"`
  (one background call, no dialog/confirmation — this is deliberately invisible to the
  customer, per decision 1). Page renders full Chrome, no top banner (already removed),
  real data everywhere (promos, rates, wallet balance, reservation availability, history,
  etc.). Any mutating control (top-up, reserve, submit inquiry, edit profile/settings) is
  visibly present but disabled/blocked with an inline "Apply to unlock" affordance instead
  of the current full-section lock card.
- (b) clicks Apply from one of those inline prompts → existing `useApplyForTenant()`-style
  flow, but now calling the modified `POST /portal/members/apply` that promotes
  `"visitor"` → `"pending"`/`"approved"`. Reload/refetch unlocks every mutating control.
- (c) staff open `/dashboard/members`, see a `"visitor"` badge on rows that haven't
  applied, and can use the existing Invite action to nudge them.

**Failure cases:**
- The silent visitor-registration call fails (network blip) → must not break page
  rendering; the page should still show whatever it can (treat as `member: null` still,
  i.e. today's guest-mode fallback stays as an error-tolerant path, not removed).
- A customer applies twice — idempotent already (existing → unchanged branch), extended to
  handle the one new visitor→pending transition, still safe to call repeatedly.
- A mutating request arrives from a `"visitor"` tenantMember (e.g. stale tab, or a direct
  API call bypassing the UI) → server-side 403, not just a UI-disabled button. This is the
  actual security boundary; the UI treatment is a courtesy on top of it.
- Cross-tenant: unaffected — `applicationStatus` is per `chronoMemberProfile` row, already
  tenant-scoped via `tenantId`/`memberId`.

**Audit/notifications:** none new — visitor creation is a low-stakes, reversible,
customer-initiated (by visiting) event; no audit trail requirement raised.

## Pass 2 — Technical planning

**No schema/migration.** Everything here is application code: new accepted string value,
one new/modified route, one new shared gate, and a UI rework.

### New shared server-side gate

Add a small helper (Chrono-side, not foundation — this is Chrono's own status column) —
e.g. `requireAppliedMembership(c)` in `apps/chrono-api/src/modules/member/access.ts` (new
file) — that reads the caller's `chronoMemberProfile.applicationStatus` (already resolved
inside `memberMiddleware()`'s context or a fresh lookup, implementer's call for the
cheapest correct approach) and throws `ForbiddenError` unless status is `"pending"` or
`"approved"`. Call it at the top of each of the 11 mutating routes listed above, after
`memberMiddleware()`, before any DB work — same placement convention as
`requirePermission()` in the tenant-admin API (`.ai/rules/api.md`).

### Visitor auto-registration

New route, e.g. `POST /portal/members/visit` (`member/portal-routes.ts`, alongside the
existing `/apply`): gated by `memberMiddleware()` only (a `tenantMember` must already
exist — this route does NOT create the `tenantMember` itself, see below); if no
`chronoMemberProfile` row exists for this member, insert one with
`applicationStatus: "visitor"`; if one already exists, return it unchanged (idempotent,
same shape as `/apply`'s existing-row branch).

Client-side call sequence when `MemberGate` detects "global customer, no `tenantMember`"
(today's `canApply` condition): instead of leaving them in a null-`member` guest mode,
silently call `applyForTenantMembership()` (foundation — already instant-access, already
idempotent per-customer) then the new visit-registration call above, then refetch/reload
into a normal `member`-present render. This reuses exactly the two existing network calls
`useApplyForTenant()` already makes — the difference is only *when* they fire (now
automatically on visit) and *what status* the profile gets (`"visitor"` instead of
`"pending"`).

### Promote-on-Apply

Modify `POST /portal/members/apply`'s existing-row branch
(`member/portal-routes.ts:137-177`): if the existing row's `applicationStatus` is
`"visitor"`, update it to `autoApprove ? "approved" : "pending"` (same logic already used
for the insert branch) instead of returning it unchanged. Any other existing status
(`"pending"`, `"approved"`, `"rejected"`) keeps today's untouched-return behavior exactly.

### Client UI rework (undoes part of `requires-membership.tsx`'s current usage)

- `MemberGate`/`MemberAreaProvider`: once visitor auto-registration lands, `member` is
  non-null immediately after the silent calls resolve — the `guestMode`/`canApply` branch
  in `member-gate.tsx` becomes rare (only the brief window before registration completes,
  or if it fails). Keep today's null-`member` fallback for that failure case, but it's no
  longer the steady-state guest experience.
- `useMemberArea()` should expose the resolved tier directly, e.g. `canInteract: boolean`
  (`applicationStatus === "pending" || "approved"`), so pages don't each re-derive it.
- `RequiresMembership` stops wrapping whole sections. Each of the 9 pages instead wraps
  only the actual mutating controls: the Wallet top-up button/dialog, the
  Reserve/Confirm/Cancel buttons + booking dialogs, the inquiry submit form, the
  profile/settings edit forms and save buttons. Reads (balances, lists, promos, rates,
  history, availability) render unconditionally once `member` exists. Replace the current
  full-card lock with a small inline disabled-state (e.g. a disabled `Button` with a
  tooltip/adjacent text "Apply to unlock" that triggers the same apply action) — exact
  component shape is an implementation-phase decision, following `.ai/rules/ui.md`/
  `.ai/rules/component-first-ui.md`.
- Dashboard (`player/page.tsx`): re-evaluate which cards were locked under the old model —
  most (playtime, membership status, wallet balance) are reads and should now show real
  data; only actionable cards (e.g. a "top up" CTA) get the inline-disabled treatment.

### Staff UI

- `dashboard/members/page.tsx`'s badge switch (~line 427-447): add a `"visitor"` branch
  (new badge variant/color, implementer's choice — follow existing outline/secondary
  pattern, don't invent a new color token per `.ai/rules/styling.md`).
- Existing Invite action reused as-is — no new route needed for this plan.

**Out of scope:**
- `inactive`/`blacklisted` statuses — explicitly deferred.
- Any change to `POST /portal/customer/apply` (foundation) or `tenantMember` creation
  logic — untouched, per its own doc comment already declaring `applicationStatus` a
  separate layer.
- Any new audit logging for visitor creation.
- Redesigning the Members list page beyond the one new badge branch.

## Phase 1 — Server: visitor status, mutation gate, promote-on-apply

**Files to update**
- `apps/chrono-api/src/modules/member/portal-routes.ts` (new `/visit` route; modify
  `/apply`'s existing-row branch)
- New: `apps/chrono-api/src/modules/member/access.ts` (`requireAppliedMembership()`)
- `apps/chrono-api/src/modules/reservation/portal-routes.ts` (4 routes)
- `apps/chrono-api/src/modules/inquiry/portal-routes.ts` (2 routes)
- `apps/chrono-api/src/modules/credit/portal-routes.ts` (1 route)
- `apps/chrono-api/src/modules/payment/portal-routes.ts` (1 route)
- `apps/chrono-api/src/modules/qr/public-routes.ts` (1 route)
- `apps/chrono-api/src/modules/member/portal-routes.ts`'s own `PATCH /me` (1 route)
- Any Zod contract that enumerates `applicationStatus` values (grep for it; update to
  include `"visitor"`)

**Step-by-step tasks**
1. Add `requireAppliedMembership(c)` in the new `access.ts`, throwing `ForbiddenError`
   (via `agora/server`) for anything other than `"pending"`/`"approved"`.
2. Add `POST /portal/members/visit` per the design above.
3. Modify `POST /portal/members/apply`'s existing-row branch to promote `"visitor"` →
   `autoApprove ? "approved" : "pending"`.
4. Insert `requireAppliedMembership(c)` at the top of each of the 11 mutating handlers
   listed in Pass 2, after `memberMiddleware()`/`requireMemberActionHeader` where present.
5. Update any Zod schema/type that lists allowed `applicationStatus` values.

**Acceptance criteria**
- A fresh `tenantMember` with no `chronoMemberProfile` row, calling `POST
  /portal/members/visit`, gets a `"visitor"` row created; calling it again returns the
  same row unchanged.
- A `"visitor"` calling `POST /portal/members/apply` gets promoted to `"pending"`/
  `"approved"` per the tenant's `autoApproveMembers` flag.
- A `"visitor"` calling any of the 11 mutating routes gets a 403.
- A `"pending"`/`"approved"` member is unaffected by the new gate on all 11 routes.
- All previously-passing read-only route behavior is unchanged.

**Verification commands**
- `pnpm --filter @agora/chrono-api typecheck`
- Manual: curl/Postman a `"visitor"` session against 2-3 of the mutating routes to confirm
  403, and against a read route to confirm 200 with real data.

## Phase 2 — Client: silent visitor registration, unlock reads, inline-disable mutations

**Files to update**
- `apps/chrono-web/src/lib/member/account.ts` (new `registerVisit()` client fn)
- `apps/chrono-web/src/components/member/member-gate.tsx`
- `apps/chrono-web/src/components/member/member-area-context.tsx` (expose `canInteract`)
- `apps/chrono-web/src/components/member/requires-membership.tsx` (repurpose for
  inline/control-level use, or replace with a smaller `LockedAction` component —
  implementer's call, whichever reads cleaner)
- All 9 pages under `apps/chrono-web/src/app/(tenant-member)/player/` — narrow their
  `RequiresMembership` usage from whole-section to just the mutating controls per the
  Pass 2 table above.

**Step-by-step tasks**
1. Add `registerVisit()` calling the new `/visit` route.
2. In `MemberGate`, when `canApply` (global customer, no `tenantMember`): call
   `applyForTenantMembership()` then `registerVisit()` in sequence, then treat the result
   the same as a normal member load (no banner, no lock) rather than returning early.
   Keep a fallback (today's guest-mode rendering) if either call fails.
3. Add `canInteract` to `useMemberArea()`'s context value.
4. Rework each of the 9 pages to unwrap read content and locally gate only mutating
   controls on `canInteract`.
5. Remove now-dead code paths from Phase 1/2 of the prior plan if this fully replaces
   them (e.g. if `RequiresMembership`'s section-wrapping mode has no remaining callers,
   delete it rather than leaving unused code, per this repo's no-dead-code convention).

**Acceptance criteria**
- Visiting `/member/*` as a signed-in global customer (no prior tenantMember) shows real
  promos/rates/wallet-balance/reservation-availability/history immediately, no full-page
  or full-section lock.
- Top-up, Reserve, Cancel, Submit-inquiry, and profile/settings Save controls are visibly
  present but disabled with an "Apply to unlock" affordance for a `"visitor"`.
- Clicking that affordance runs the promote-on-apply flow and unlocks those controls
  without a page reload being required (or with one, if that's the simplest correct
  implementation — developer's call at implementation time).
- Pending/approved members: fully unaffected, unchanged from current behavior.

**Verification commands**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual pass across all 9 pages in visitor mode + pending/approved mode.

## Phase 3 — E2E coverage

**Files to update**
- `apps/chrono-web/e2e/tests/member/guest-preview-banner.spec.ts` (rename/rework —
  "guest" no longer exists as a no-member state in the steady case; retitle to reflect
  visitor behavior)
- `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts`,
  `venue-status.spec.ts`, `lounge-directory.spec.ts` — update assertions again (this is
  the third revision of these specs across this and the prior plan; get the final shape
  right this time by asserting against the actual shipped Phase 1/2 UI, not the plan
  prose)
- New: a spec asserting a `"visitor"` cannot mutate (403 or disabled-control assertion)
  and can read real data, and that Apply promotes them.

**Acceptance criteria:** existing specs pass against the new steady-state behavior; new
spec covers the visitor read/no-mutate/promote-on-apply lifecycle end to end.

**Verification commands**
- `pnpm --filter @agora/chrono-web e2e -- member global-customers`

## Execution start point

`apps/chrono-api/src/modules/member/portal-routes.ts` — read the full file (the `/apply`
route especially, lines 137-177) before writing `access.ts` or the new `/visit` route;
Phase 1 changes this file first, everything else follows from its shape.

## Plan closure

Once all phases land and verify, move this plan from `draft/` → `ready/` →
`in-progress/` → `.ai/plans/chrono/archive/member-visitor-status-tier/README.md` per
`.ai/rules/feature-planning.md`.
