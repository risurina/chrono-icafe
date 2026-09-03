# Wire credit grants into session start/billing

## Status: Accepted (developer directed to proceed on recommended design, 2026-09-03)

## Pass 1 — Workflow Analysis

**Who**: every tenant customer who buys a `ChronoCreditProduct` (a prepaid minutes
package), and every staff member who starts/ends sessions for them.

**Current broken workflow**: a customer buys a credit package (`POST
/credits/members/:id/purchase`) — this correctly debits their wallet and creates a
`ChronoCreditGrant` lot. But:

1. If that purchase drained their wallet to zero, `startSession` unconditionally throws
   `422 Insufficient wallet balance to start a session` — the customer cannot start any
   session at all, despite holding paid-for minutes. This blocks both the staff-counter
   start route and the QR self-service start route (`qr/public-routes.ts`), since both
   call the same `startSession`.
2. Even when a session can be started (member still has some wallet balance), closing it
   (`closeSession`) bills 100% of elapsed time against the wallet. Nothing in
   `session/service.ts` ever calls `credit/service.ts`'s `consumeCredits`. The grant just
   sits there, untouched, until a staff member manually calls the disconnected `POST
   /credits/members/:id/consume` action — which has no relationship to any actual
   session.

Net effect: a purchased credit package currently provides no functional benefit. This is
a money-correctness bug, not a missing nice-to-have.

**Failure cases to handle**: zero wallet + zero credits (still refused, unchanged
message); credits fully cover the session (no wallet debit at all); credits partially
cover it (shortfall billed to wallet, same cap-and-record-shortfall behavior already in
place); multiple eligible grants (existing `consumeCredits` priority/expiry/eligibility
ordering already handles this — reused as-is).

## Pass 2 — Technical Planning

**Reused as-is** (no changes): `credit/service.ts`'s `consumeCredits`,
`scoreGrantEligibility`, `applyGrantDelta` — these already do exactly what's needed
(deterministic lot selection, row-locking, ledger write with `referenceType`/
`referenceId` free-text columns the schema already reserved for this: see
`ChronoCreditGrantLedgerEntries.referenceType`'s comment, "session (future, unenforced
today — the deferred sessions amendment can start writing this value with zero
migration)"). `credit/schema.ts` needs **no changes**.

**Design decisions** (developer directed: proceed with these, no further sign-off
needed):

1. **Start-eligibility gate**: `startSession` allows starting when wallet balance > 0
   **OR** the member holds at least one eligible active credit grant for the station's
   `stationGroupId` (same eligibility scoring `consumeCredits` already uses). New
   read-only helper in `credit/service.ts`: `hasEligibleCreditBalance`.
2. **Consumption order at close**: credits first, wallet second. (oikos billed wallet
   first specifically because its sessions ticked incrementally; Chrono's single-final-
   debit model has no such constraint, and a customer who paid for a bundle of minutes
   should reasonably see those minutes spent before further cash is drawn.)
3. **Time/minute conversion**: `creditMinutesElapsed = ceil(billableSeconds / 60)` —
   round up, consistent with "pay for any started minute." Consume
   `min(creditMinutesElapsed, eligible balance)` via the existing `consumeCredits`. The
   remaining time — `max(0, billableSeconds - consumedMinutes * 60)` — is what
   `computeMeteredCharge` prices in money, replacing today's full-`billableSeconds`
   call. `finalAmount`/`amountCharged` therefore become "cost of the portion not covered
   by credits," not "cost of the whole session" — schema comment updated to say so.
4. **Eligibility scoping**: freeze `stationGroupId` on the session row at start (new
   column), mirroring the existing `rateSnapshot`/`rateSource`/`branchId` freeze-at-start
   precedent, so a mid-session station/group reassignment can't retroactively change
   which lots are eligible. Nullable (existing pre-migration rows have none); a null
   value only affects `strict_group_only` lots, which simply won't be drawn from for an
   in-flight session that predates this migration — negligible, no backfill needed.
5. **No new permission checks**: `consumeCredits` is invoked directly from
   `session/service.ts`, exactly like `debitWallet` already is — internal cross-module
   calls in this codebase don't re-check the callee module's own route-level
   permissions; the session route's existing `session:update` gate is what's
   authoritative here, same as it already is for the wallet debit.

## Files to Update

- `apps/chrono-api/src/modules/session/schema.ts` — add `stationGroupId` (nullable,
  `references(() => chronoStationGroup.id, { onDelete: "set null" })`) and
  `creditMinutesConsumed` (`integer().notNull().default(0)`) to `chronoSession`; update
  the `finalAmount`/`amountCharged` doc comment to reflect the new "post-credit" meaning.
- `apps/chrono-api/src/modules/credit/service.ts` — add
  `hasEligibleCreditBalance(tx, { tenantId, memberId, stationGroupId }): Promise<boolean>`.
- `apps/chrono-api/src/modules/session/service.ts` — `startSession`: relax the balance
  gate per decision 1, snapshot `stationGroupId` on insert. `closeSession`: consume
  credits before pricing the remainder per decisions 2–4, persist
  `creditMinutesConsumed`.
- `apps/chrono-api/src/modules/session/routes.ts` — add `creditMinutesConsumed` to the
  `/sessions` list route's explicit column allowlist.
- New Drizzle migration via `pnpm db:generate --name add_session_credit_consumption`.
- `apps/chrono-web/e2e/tests/sessions/sessions.spec.ts` — new test: a member with a
  credit grant and zero wallet balance can start a session (previously 422'd), and
  ending it consumes minutes from the grant before touching the wallet.

## Acceptance Criteria

- A member with $0 wallet balance and an active, unexpired credit grant can start a
  session (staff route and QR route both, since both funnel through `startSession`).
- A member with $0 wallet and no credit grant still gets the existing 422.
- Ending a session consumes credit minutes first (ceil-rounded, existing
  priority/expiry/eligibility order), writes a `ChronoCreditGrantLedgerEntries` row with
  `referenceType: "session"` / `referenceId: <sessionId>`, and only debits the wallet for
  time not covered by credits — capped/recorded exactly as today if the wallet can't
  cover the remainder.
- `chronoSession.creditMinutesConsumed` reflects the actual minutes drawn.
- `pnpm typecheck` and `pnpm --filter @agora/api rls:proof` pass.
- New e2e test passes; existing `sessions.spec.ts` tests still pass unmodified.

## Verification Commands

- `pnpm --filter @agora/api db:generate --name add_session_credit_consumption`
- `pnpm --filter @agora/api db:migrate`
- `pnpm typecheck`
- `pnpm --filter @agora/api rls:proof`
- `pnpm --filter @agora/chrono-web test:e2e -- sessions` (or the project's equivalent
  Playwright invocation for the sessions spec)

## Out of Scope

- UI surfacing of `creditMinutesConsumed` on the session-end toast / session history
  table (backend correctness first; a follow-up UI pass can show "12 min from credits +
  $3.40 charged").
- Any change to `credit/routes.ts`'s standalone manual `/consume` action — it remains a
  separate staff tool (e.g. for phone/counter adjustments unrelated to a session).
- POSTPAID billing, online top-up, reservation policy engine, station-grid dashboard,
  remote PC commands — separate gaps from the same audit, not touched here.

## Execution Start Point

`apps/chrono-api/src/modules/session/schema.ts` (schema change first, per the standard
DB → contracts → routes → e2e phase order).

## Verification Notes (2026-09-03)

- Migration generated (`0017_add_session_credit_consumption.sql`, additive/non-
  destructive) and applied; `rls:proof` and `pnpm typecheck` both pass.
- The new e2e test was written and is correctly scoped (`npx playwright test
  e2e/tests/sessions/sessions.spec.ts -g "..."` — note: `pnpm e2e -- <args>` does NOT
  forward the file/`-g` filter correctly in this repo and queues the entire ~184-test
  suite instead; invoke `npx playwright test` directly from `apps/chrono-web`).
- Running it (headed and headless) surfaced a **pre-existing, unrelated failure**: the
  shared `signUp()` test helper's `page.waitForURL(/\/dashboard/)` times out after
  sign-up, even though the log shows the browser did navigate to `/dashboard`. Confirmed
  this is NOT caused by this plan's changes — the original, unmodified "happy path" test
  in the same file fails identically on a clean checkout of `sessions.spec.ts` before any
  of this plan's edits. This blocks all of `sessions.spec.ts`, not just the new test.
  **Not fixed here** — out of scope for this plan (a signup/onboarding-redirect e2e
  harness issue, not a session-billing one); flagged for separate investigation. Given
  the earlier audit found `resolveLandingUrl()` now sends brand-new owners to
  `/dashboard/setup` rather than bare `/dashboard`, the redirect chain intersecting with
  this wait is the prime suspect.
- Backend correctness (the actual acceptance criteria) was therefore verified by code
  review + typecheck + rls:proof, not by a green e2e run. Re-run
  `npx playwright test e2e/tests/sessions/sessions.spec.ts -g "credit grants"` from
  `apps/chrono-web` once the signUp-helper issue is fixed to get real e2e confirmation.
