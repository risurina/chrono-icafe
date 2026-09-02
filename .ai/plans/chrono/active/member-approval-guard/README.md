# Chrono — `member-approval-guard` (bug fix)

**Type:** defect fix in **landed, shipped code**. Not a feature.
**Depends on:** nothing. **Blocks:** nothing.
**Independently shippable today** — do not wait for, or bundle into, any onboarding plan.

## Why this is its own plan

The defect below was found while auditing `.ai/plans/chrono/active/customer-onboarding/`,
and was originally written into that plan's Phase 1 as a prerequisite step. That was the
wrong home for it: `customer-onboarding` is **unstarted** (verified — no
`modules/onboarding`, no `dashboard/setup`, no dismissal table, nothing in git history
beyond plan docs), and may not be built for some time. A live defect in shipped code must
not be held hostage to an unstarted feature.

So it is extracted here: small, self-contained, no schema change, no new dependency.
`customer-onboarding` now *depends* on this plan rather than containing it.

---

## The defect

`apps/chrono-api/src/modules/member/routes.ts` — **both** the approve handler (line 162)
and the reject handler (line 188) write the status transition with no predicate on the
*current* status:

```ts
// approve, line ~167 — and reject at ~193 is identical in shape
.update(chronoMemberProfile)
.set({ applicationStatus: "approved", approvedAt: new Date(), updatedAt: new Date() })
.where(eq(chronoMemberProfile.memberId, memberId))   // ← no status predicate
.returning()
```

`if (!row) throw new HttpError(404, …)` only catches a *missing* profile. Any existing
profile in any state is overwritten unconditionally.

### Consequences, in order of severity

1. **Audit-trail corruption (the real damage).** Re-approving an already-approved member
   re-stamps `approvedAt`, destroying the true approval time. Same for `rejectedAt`.
   These columns are the only record of when a venue accepted or refused a customer;
   there is no history table behind them.
2. **A no-op writes a real audit event.** `recordStaffAudit` fires with
   `chronoMemberProfile.approved` even when nothing changed, so the platform audit log
   shows approvals that never happened.
3. **Silent state resurrection / demotion.** `rejected → approved` and
   `approved → rejected` both succeed silently and are indistinguishable in the audit log
   from a first-time decision. A reversal of a venue's earlier decision should be legible
   as a reversal.
4. **Concurrent double-approve both succeed**, writing two audit events for one
   transition.
5. **Latent, activates later:** `customer-onboarding` adds a customer-facing email inside
   these handlers. With no guard, every duplicate call re-sends the approval email to the
   customer. This is why the fix must land *before* that plan, not inside it.

### Blast radius — accurate scope

`applicationStatus` has **no access enforcement anywhere**. Verified: the only consumer
outside these handlers is `session/routes.ts:161-165`, which uses it to choose
`group.memberRate` over `group.hourlyRate` — a **pricing** decision. The schema comment
says so explicitly (`member/schema.ts:20`: *"this field carries no enforcement yet"*).

So this is **not** an access-control vulnerability, and should not be filed as one. A
pending customer can already start a session; they simply pay the standard rate. The
damage is to audit integrity (1–4) plus mispriced sessions if a status is flipped by
accident.

---

## The fix

Make each transition conditional and idempotent-by-refusal, rather than
unconditional-and-silent.

```ts
.where(and(
  eq(chronoMemberProfile.memberId, memberId),
  ne(chronoMemberProfile.applicationStatus, "approved"),   // "rejected" in the reject handler
))
```

Then distinguish the two zero-row cases, which the current 404 conflates:

- profile does not exist → **404** (unchanged behaviour)
- profile exists but is already in the target state → **409**, no audit event, no write

A conditional `UPDATE … WHERE status <> target` is atomic under Postgres row locking, so
the guard also resolves consequence 4 for free: the second concurrent caller matches zero
rows and gets the 409. No advisory lock or transaction-isolation change is needed.

**Audit events record the transition, not just the destination.** Add the previous status
to the event metadata (`from: row.applicationStatus` captured before the write, `to:
"approved"`), so a reversal is legible as a reversal in the platform audit log.

**Transitions stay permissive.** `approved → rejected` and `rejected → approved` remain
*allowed* — a venue reconsidering is a real operation and this plan does not remove it.
Only the silent no-op is refused. Locking the state machine down further is a product
decision, deliberately out of scope (see below).

---

## Pass 1 — Workflow Analysis

**Who:** venue `staff`/`admin`/`owner` holding `customer:approve` / `customer:reject` —
gates unchanged, still checked first, before any DB work.

**Workflow:** unchanged in the happy path. A staff member approving a pending applicant
sees exactly what they see today. The only behavioural change is that a *redundant*
approve/reject now returns a clear 409 ("already approved") instead of silently
succeeding.

**Failure cases:** double-click / double-submit → first wins, second gets 409 (today: two
audit events and a re-stamped timestamp). Two staff acting simultaneously → same. Staff
without the permission → unchanged 403. Missing profile → unchanged 404. Cross-tenant →
unchanged; both handlers already run under `withTenant`.

**Audit / notifications:** one audit event per *real* transition, now carrying `from`/`to`.
No notification exists yet — `customer-onboarding` adds it later, on top of this guard.

---

## Pass 2 — Technical Planning

**Files to change:** `apps/chrono-api/src/modules/member/routes.ts` only.
**No schema change.** No migration, no `APP_TENANT_TABLES` edit, no RLS impact — so
`.ai/rules/database.md`'s plan-first schema gate does not apply, and `rls:proof` is
unaffected (run it anyway; it is cheap and this touches a tenant-scoped write).
**No contract change.** The response shape is unchanged; only a new status code.
**No permission change.**

**Pattern to copy:** the repo's existing atomic-guard idiom — `pos`'s void path and
`wallet`'s adjust path both use a conditional update to make a state change
single-shot. Read `apps/chrono-api/src/modules/pos/routes.ts` (the `pos:void` handler,
~line 399) before writing, and match its 409 shape and error message style rather than
inventing one.

---

## Phase 1 — Guard both transitions

**Files to update**
- `apps/chrono-api/src/modules/member/routes.ts` (approve ~162, reject ~188)

**Step-by-step tasks**
1. Read the `pos:void` handler first and match its conflict-handling shape.
2. In the approve handler: capture the pre-write status, add
   `ne(applicationStatus, "approved")` to the `.where(...)`, and import `ne`/`and` if not
   already imported in that file.
3. Distinguish the zero-row cases: re-select the profile on zero rows; absent → 404
   (unchanged), present → 409 with a message naming the current state.
4. Pass `from`/`to` into `recordStaffAudit`'s metadata; ensure the audit call happens only
   on a real transition (after the guard, not before it).
5. Repeat 2–4 for the reject handler with `"rejected"`.
6. Confirm `requirePermission` still runs **before** any DB work in both handlers.

**Acceptance criteria**
- Approving a pending profile succeeds and stamps `approvedAt` once.
- Approving an already-approved profile returns 409, writes **no** audit event, and leaves
  `approvedAt` **unchanged** (assert the timestamp is byte-identical before and after).
- Approving a rejected profile succeeds and the audit event records
  `from: "rejected", to: "approved"`.
- Same four properties for reject.
- A missing profile still returns 404, not 409.
- Permission gates unchanged: a `staff` user without `customer:approve` still gets 403.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** the concurrency test (Phase 2); notifications (that is
`customer-onboarding`'s).

**Execution start point:** `apps/chrono-api/src/modules/pos/routes.ts`, the `pos:void`
handler — copy its conflict shape, then apply it at `member/routes.ts:162`.

---

## Phase 2 — Concurrency + regression test

**Files to update**
- `apps/chrono-api/src/modules/member/approval-concurrency.test.ts` (new)
- `apps/chrono-api/package.json` — add `"test:member-approval": "tsx
  src/modules/member/approval-concurrency.test.ts"`, matching the 17 existing `test:*`
  entries.

**Step-by-step tasks**
1. Copy the harness from an existing concurrency test —
   `apps/chrono-api/src/modules/wallet/concurrency.test.ts` is the closest precedent
   (`test:wallet-concurrency`).
2. Fire N concurrent approves at one pending profile; assert **exactly one** succeeds,
   N−1 return 409, exactly one audit event exists, and `approvedAt` was written once.
3. Add the plain regression cases: re-approve → 409 + unchanged timestamp; reject an
   approved profile → succeeds with `from: "approved"`.

**Acceptance criteria**
- The test **fails** if the `ne(...)` predicate is removed from either handler. A guard
  test that passes either way is testing plumbing, not the guard
  (`.ai/rules/rbac.md`'s standard, applied here to a state guard).

**Verification commands**
- `pnpm --filter @agora/chrono-api test:member-approval`
- `pnpm typecheck`

**Out of scope:** browser e2e — this is a server-side state guard with no UI change; the
existing member e2e coverage is unaffected.

**Execution start point:** `apps/chrono-api/src/modules/wallet/concurrency.test.ts`.

---

## Phase 3 — Decouple `customer-onboarding`

**Files to update**
- `.ai/plans/chrono/active/customer-onboarding/README.md`

**Step-by-step tasks**
1. Replace Decision 4's inline fix instruction with a dependency reference to this plan.
2. Remove the guard step from that plan's Phase 1 task list; leave its notification step,
   noting it requires this plan to have landed.

**Acceptance criteria**
- The guard is specified in exactly one place across all plans.

**Verification commands** — none (docs only).

**Execution start point:** that plan's "Decision 4" section.

---

## Out of Scope

- **Locking the state machine down further** (e.g. forbidding `approved → rejected`
  outright, or requiring a reason to reverse). That is a product decision about how a
  venue may change its mind, not a defect fix. Flagged for the developer below.
- **A status-history table.** The `from`/`to` audit metadata is the cheap 80% fix; a full
  transition ledger is a separate design if it is ever wanted.
- **Adding access enforcement to `applicationStatus`.** It is pricing-only today by
  deliberate design (`member/schema.ts:20`). Whether a pending customer should be blocked
  from sessions entirely is a real product question — but it is a *behaviour change*, not
  a bug fix, and belongs with `customer-onboarding`.
- Anything in `customer-onboarding`, `onboarding-checklist`, or `onboarding-wizard`.

---

## Open Questions (developer to confirm)

1. **409 vs. silent success on a redundant call.** This plan chooses 409 because a caller
   should know its write did nothing. The alternative (200 with the existing row, no
   write, no audit) is friendlier to a double-clicking UI. 409 is recommended — the
   dashboard can present it as a benign "already approved" — but if you would rather the
   UI never see an error for a harmless repeat, say so and Phase 1 flips to the 200 form.
   Everything else in the plan is unchanged either way.
2. **Should reversing a decision require a distinct permission?** Today `customer:approve`
   covers both "approve a new applicant" and "reinstate someone this venue previously
   rejected". Those are arguably different-weight decisions. Out of scope as written; say
   the word if you want it split.
