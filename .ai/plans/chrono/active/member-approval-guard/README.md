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
   transition. Under READ COMMITTED the two unconditional updates serialize on the row
   lock and both succeed — there is no predicate to re-evaluate.
5. **Latent, activates later:** `customer-onboarding` adds a customer-facing email inside
   these handlers. With no guard, every duplicate call re-sends the approval email to the
   customer. This is why the fix must land *before* that plan, not inside it.

### What is actually reachable today — read this before triaging urgency

**Consequence 3 is not reachable through the shipped UI.**
`apps/chrono-web/src/app/dashboard/members/page.tsx:187` renders the Approve/Reject
buttons **only** when `applicationStatus === "pending"`. So `approved → rejected` and
`rejected → approved` cannot be produced by a staff member clicking the dashboard — only
by a direct API call, or by the double-submit race on a genuinely pending row.

**The live exposure is therefore (4), the double-submit race**, with (1) and (2) as its
consequence. That is still worth fixing — a double-click is easy and the timestamp damage
is unrecoverable — but this is not a burning production incident, and the plan should not
be read as claiming one. Phase 1's acceptance criteria deliberately cover the
UI-unreachable transitions anyway, because the API accepts them and
`customer-onboarding` will add an email to that path.

### Blast radius — no access enforcement, but six consumers, not one

`applicationStatus` has **no access enforcement anywhere** — that conclusion is verified
and holds. But an earlier draft of this plan claimed the session pricing read was "the
only consumer outside these handlers", which is false. The full set:

| Consumer | Kind | Enforces access? |
|---|---|---|
| `session/routes.ts:156-170` | reads it to pick `group.memberRate` over `hourlyRate` | no — **pricing** |
| `member/portal-routes.ts:56` | **writes** `"pending"` on self-service apply | no |
| `member/routes.ts:95,119` | list projection | no |
| `chrono-web/portal/page.tsx:119-127` | customer-facing status badge | no |
| `chrono-web/dashboard/members/page.tsx:32,176-187` | status badge + approve/reject button visibility | no — display |
| `member/routes.ts:171,197` | the two handlers this plan fixes | no |

Session *start* gates on `base.tenantMember.status !== "active"`
(`session/routes.ts:150-153`), **not** on `applicationStatus`. The schema comment is at
`member/schema.ts:21`: *"this field carries no enforcement yet."*

So this is **not** an access-control vulnerability and must not be filed as one. A pending
customer can already start a session; they simply pay the standard rate. The damage is
audit integrity plus a mispriced session if a status is flipped by accident.

---

## The fix

Make each transition conditional and idempotent-by-refusal, rather than
unconditional-and-silent.

```ts
.where(and(
  eq(chronoMemberProfile.memberId, memberId),
  // NOT ne(...) — `ne` is not exported from `agora/db` (see the export note below).
  not(eq(chronoMemberProfile.applicationStatus, "approved")),  // "rejected" in the reject handler
))
```

**`ne` does not exist in `agora/db`.** `packages/agora/src/db/index.ts:11-30` re-exports
`eq`/`and`/`not`/… but **no `ne`**, and deep-importing from `drizzle-orm` in an app
violates `.ai/rules/monorepo.md` ("Apps import public package exports only"). Use
`not(eq(...))`, which is already exported. The alternative — re-exporting `ne` from the
foundation — is *also* fine but makes this no longer a single-app-file change, so it is
not the default here.

Then distinguish the two zero-row cases, which the current 404 conflates:

- profile does not exist → **404** (unchanged behaviour)
- profile exists but is already in the target state → **409**, no audit event, no write

### Why a conditional update here, when wallet/pos/credit all use explicit locks

This case **deliberately diverges** from the repo's other concurrency guards, and the
divergence needs stating or the next reviewer will read it as an oversight.

`refundSale` (`pos/service.ts:286-297`) and `lockWalletForUpdate`
(`wallet/service.ts:22-41`) both take an explicit pessimistic lock — `.for("update")` —
then re-check status while holding it. They **must**: each reads a balance or status,
computes a derived value from it, and writes that value back, sometimes across several
rows. A conditional update cannot express that safely.

This transition is different in kind: **a single statement, over a single row, writing
constants** (`"approved"`, `new Date()`), with no read-then-compute-then-write. So
`UPDATE … WHERE memberId = ? AND NOT (status = target)` is sufficient on its own. Under
READ COMMITTED the second concurrent caller blocks on the row lock, re-evaluates the
predicate after the first commits (`EvalPlanQual`), matches zero rows, and gets the 409.
Consequence 4 is resolved with no advisory lock and no isolation change.

If the handler ever grows a computed value (a fee, a counted quota), this reasoning stops
holding and it should move to the `refundSale` lock idiom.

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

**Files to change:** `apps/chrono-api/src/modules/member/routes.ts`, a new
`apps/chrono-api/src/modules/member/service.ts` (the module has no service layer today —
only `contracts.ts`, `portal-routes.ts`, `routes.ts`, `schema.ts` — and Phase 2's test
cannot exercise the real code path without one, see Phase 1 step 2), **and**
`apps/chrono-web/src/app/dashboard/members/page.tsx` (see "The UI consequence" below —
the web change is required, not optional polish).
**No schema change.** No migration, no `APP_TENANT_TABLES` edit, no RLS impact — so
`.ai/rules/database.md`'s plan-first schema gate does not apply, and `rls:proof` is
unaffected (run it anyway; it is cheap and this touches a tenant-scoped write).
**No contract change.** The response shape is unchanged; only a new status code.
**No permission change.**

### The UI consequence — prevent first, absorb second. Do NOT just show the 409.

An earlier draft claimed "no UI change", then corrected to "add a 409 branch with a nicer
message". **Both were wrong**, and the second is the more dangerous because it sounds
finished.

`apps/chrono-web/src/app/dashboard/members/page.tsx:189-204`: the Approve/Reject buttons
are bare `onClick` handlers with **no in-flight disabled state**, and
`approveMember`/`rejectMember` (`:70-96`) handle only `res.ok` / `403` / else → a generic
*"Could not update the application."* toast. So a double-click today fires two requests,
and once the guard lands the user would see **a green success and a red error at the same
time**, for one intended action. That is worse than the silent bug being fixed.

The API contract question (409 vs 200) and the UI question are **separate decisions**, and
conflating them is what produced the bad answer. 409 is right for the API — see Decisions.
The UI must then do two things, in this order:

1. **Prevent the race.** Disable both buttons for that row while a request is in flight
   (per-row busy state, since the list renders many rows). This removes the realistic
   trigger entirely — the double-click never becomes two requests. This is the actual UX
   fix; the server guard is the safety net beneath it, not the user-facing mechanism.
2. **Absorb the 409 as benign, not as an error.** If it still happens — two staff in two
   browsers, or two tabs — the end state is exactly what the user wanted. So: call
   `loadAll()` to resync the row, and show either nothing or a neutral
   `toast.info("Already approved — the list has been refreshed.")`. **Never
   `toast.error`.** An outcome the user asked for and received is not a failure.

Net effect: a human should essentially never see the 409. It exists so the *data* is
correct and the audit log is honest, not so the UI can report a conflict.

**Pattern to copy — for the 409 *shape* only, not the mechanism.** An earlier draft of
this plan claimed `pos`'s void path and `wallet`'s adjust path "both use a conditional
update". **Neither does** — both use `SELECT … FOR UPDATE` plus a status re-check (see
"Why a conditional update here" above). Copying their mechanism would contradict this
plan's own prescription.

What to actually copy: the **error contract** in `refundSale`
(`apps/chrono-api/src/modules/pos/service.ts:293-297`) — `404` for a missing row, then
`throw new HttpError(409, "This sale has already been refunded.")` for the already-in-state
case. Match that message style (`"This application has already been approved."`), not its
locking.

---

## Phase 1 — Guard both transitions

**Files to update**
- `apps/chrono-api/src/modules/member/service.ts` (**new**)
- `apps/chrono-api/src/modules/member/routes.ts` (approve ~162, reject ~188)
- `apps/chrono-web/src/app/dashboard/members/page.tsx` (handlers ~70-96, buttons ~189-204)

**Step-by-step tasks**
1. Read `refundSale` (`pos/service.ts:277-300`) for the 404/409 **error contract** — not
   its locking, which this plan deliberately does not copy.
2. **Extract `approveMemberProfile(tx, { tenantId, memberId })` and
   `rejectMemberProfile(tx, …)` into the new `service.ts`**, mirroring `pos/service.ts`'s
   shape (takes a `TenantTx`, throws `HttpError`, returns the updated row plus the
   previous status). This is required, not tidiness: `recordStaffAudit(c, …)` needs a Hono
   `Context`, so as long as the logic lives inline in the handler, Phase 2's test cannot
   call the same code path the route does — and its acceptance criterion becomes
   unmeetable. The audit write **stays in the route**; only the guarded transition moves.
3. In the service: capture the pre-write status, and guard the update with
   `not(eq(chronoMemberProfile.applicationStatus, "approved"))` — **not** `ne`, which
   `agora/db` does not export.
4. Distinguish the zero-row cases **inside the same `withTenant` callback**: on zero rows,
   `SELECT` the profile in that same transaction; absent → 404 (unchanged), present → 409
   naming the current state. Keeping it in one callback avoids a second-transaction race
   (see "The re-select" note below).
5. In the route: call the service, then pass `from`/`to` into `recordStaffAudit`'s
   metadata. The audit call must run only on a real transition — after the service
   returns, never before the guard.
6. Repeat 2–5 for reject with `"rejected"`.
7. Confirm `requirePermission` still runs **before** any DB work in both handlers.
8. **Web (`apps/chrono-web/src/app/dashboard/members/page.tsx`)** — see "The UI
   consequence" above; this is a required part of Phase 1, not a follow-up:
   a. Add a per-row in-flight busy state and disable that row's Approve/Reject while a
      request is outstanding. Per-row, not page-level — the list renders many rows and a
      global flag would freeze unrelated ones.
   b. Add a `409` branch to `approveMember`/`rejectMember` that calls `loadAll()` and
      shows a neutral `toast.info(...)` — **never `toast.error`**. Leave the existing
      `403` and generic-else branches as they are.

**The re-select — benign, and why.** Even inside one transaction the split is a second
statement; across transactions it would be racy (row deleted between → stale 409; row
inserted → stale 404). Both are harmless misreports of an already-failed call, and no
state is corrupted either way. Step 4 keeps it in one callback so the window closes to
nothing that matters. Do not add a lock for this.

**Acceptance criteria**
- Approving a pending profile succeeds and stamps `approvedAt` once.
- Approving an already-approved profile returns 409, writes **no** audit event, and leaves
  `approvedAt` **unchanged** (assert the timestamp is byte-identical before and after).
- Approving a rejected profile succeeds and the audit event records
  `from: "rejected", to: "approved"`.
- Same four properties for reject.
- A missing profile still returns 404, not 409.
- Permission gates unchanged: a `staff` user without `customer:approve` still gets 403.

(The `rejected → approved` and `approved → rejected` criteria are exercised via direct API
call — the dashboard hides those buttons on non-pending rows, per "What is actually
reachable today". They are still specified because the API accepts them.)

**UI acceptance:**
- Double-clicking Approve fires **one** request, not two — the button disables on the
  first click. Verify by watching the network panel, not by reasoning about it.
- Disabling one row's buttons does not disable any other row's.
- When a 409 *is* forced (two tabs), the user sees a neutral info message and a refreshed
  row — **no red error toast**, and no green-success-plus-red-error pair.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** the concurrency test (Phase 2); notifications (that is
`customer-onboarding`'s).

**Execution start point:** `apps/chrono-api/src/modules/pos/service.ts` — read
`refundSale` (lines 277-300) for its 404/409 error contract and its route↔service split,
then build `member/service.ts` on that shape. **Do not copy its `.for("update")` lock**;
see "Why a conditional update here" above.

---

## Phase 2 — Concurrency + regression test

**Files to update**
- `apps/chrono-api/src/modules/member/concurrency.test.ts` (new)
- `apps/chrono-api/package.json` — add `"test:member-concurrency": "tsx
  src/modules/member/concurrency.test.ts"`.

**Naming:** there are **12** `test:*` entries today, and four follow the convention
`test:<module>-concurrency` → `src/modules/<module>/concurrency.test.ts` (wallet, pos,
credit, session). Match it exactly. An earlier draft proposed
`test:member-approval` → `approval-concurrency.test.ts`, diverging on both halves.

**Step-by-step tasks**
1. Copy the harness from `apps/chrono-api/src/modules/wallet/concurrency.test.ts` — a
   standalone tsx script firing concurrent calls at **service functions** over real
   Postgres connections.
2. Point it at `approveMemberProfile` from Phase 1's `service.ts` — this is why the
   extraction is a Phase 1 deliverable. Calling the route would need a Hono `Context`;
   re-implementing the SQL in the test would mean removing the guard from `service.ts`
   **would not fail the test**, which is exactly the "testing plumbing, not the gate"
   failure the criterion below forbids.
3. Fire N concurrent approves at one pending profile; assert **exactly one** succeeds and
   N−1 raise 409, and that `approvedAt` was written once.
4. Add the regression cases: re-approve → 409 + byte-identical timestamp; reject an
   approved profile → succeeds, reporting `from: "approved"`.

**Acceptance criteria**
- The test **fails** if the `not(eq(...))` predicate is removed from `service.ts`. Verify
  this by actually deleting the predicate and watching it go red — a guard test that
  passes either way is testing plumbing, not the guard (`.ai/rules/rbac.md`'s standard,
  applied here to a state guard).
- Audit-event counting is **not** asserted here — `recordStaffAudit` stays in the route,
  outside this harness's reach. It is covered by Phase 1's manual acceptance instead.

**Verification commands**
- `pnpm --filter @agora/chrono-api test:member-approval`
- `pnpm typecheck`

**Out of scope:** browser e2e — this is a server-side state guard with no UI change; the
existing member e2e coverage is unaffected.

**Execution start point:** `apps/chrono-api/src/modules/wallet/concurrency.test.ts` —
confirm Phase 1's `service.ts` exists first; without it this phase cannot be built.

---

## Phase 3 — Decouple `customer-onboarding`

**Files to update**
- `.ai/plans/chrono/active/customer-onboarding/README.md` — **already done** (verified: it
  references this plan as a dependency at its header and Decision 4, and duplicates no fix
  instruction). Confirm, do not redo.
- `.ai/plans/chrono/active/members/README.md:305-310` — **still stale.** It specifies the
  landed behaviour verbatim (*"Sets `applicationStatus: "approved"`, `approvedAt: now()`.
  404 if not found/wrong tenant"*) with no guard and no 409, and its line 245 carries the
  "nothing reads `applicationStatus` to block an action" note. That plan is in `active/`
  and will contradict shipped code once this lands.

**Step-by-step tasks**
1. Confirm `customer-onboarding`'s dependency reference is intact.
2. Add a note at `members/README.md:305-310` that the approve/reject route spec is
   superseded by this plan (guarded transition, 409 on no-op, `from`/`to` in the audit
   event).

**Acceptance criteria**
- `grep -rn "applicationStatus" .ai/plans/chrono/active/` shows the guard specified in
  exactly one place, with every other mention being a dependency or superseded-by pointer.

**Verification commands** — none (docs only).

**Out of scope:** any change to what those two plans actually build. This phase only
removes duplicated/stale *specification* of the guard, so the fix has exactly one owner.
Do not revise `members/README.md`'s other sections while in there.

**Execution start point:** `customer-onboarding`'s "Decision 4" section (confirm only),
then `members/README.md:305-310`.

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

## Decisions (resolved — no blockers remain)

1. **409, not silent success, on a redundant call — DECIDED 2026-09-02 by the developer.**
   A redundant approve/reject returns **409 Conflict** with a message naming the current
   state (*"This application has already been approved."*), writes nothing, and emits no
   audit event. The rejected alternative was 200-with-the-existing-row.

   Rationale, recorded so it is not re-litigated: the realistic trigger is a double-click,
   and 409 lets the dashboard say "already approved" — accurate, and it distinguishes
   "clicked twice" from "clicked once" in the logs, which 200 cannot without extra
   bookkeeping. Once `customer-onboarding` adds the approval email, 409 also makes "why
   was no second email sent?" self-explanatory. The cost — an error status for a harmless
   repeat — is paid off by the 409 UI branch in Phase 1, so the user sees a reassuring
   message rather than a generic failure toast.

   **Phase 1 and Phase 2 are written against this form and need no change.** This was the
   plan's only blocking question; Phase 1 is now ready to start.
## Open Questions (non-blocking)

1. **Should reversing a decision require a distinct permission?** Today `customer:approve`
   covers both "approve a new applicant" and "reinstate someone this venue previously
   rejected". Those are arguably different-weight decisions. Out of scope as written, and
   it does **not** block any phase — splitting it later is additive. Say the word if you
   want it split.
