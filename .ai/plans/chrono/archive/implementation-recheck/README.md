# Chrono — `implementation-recheck`

Re-verifies five commits that landed **outside the normal plan → implement →
verify flow**. They were written during an audit session by an agent whose role
in this repo is planning and plan-audit, not implementation
(`.ai/rules/feature-planning.md`, "Model & Delegation Policy"). The developer
has decided to keep them.

**The point of this plan is not to redo the work — it is to subject it to the
review it skipped.** Treat every line in these five commits as unreviewed
third-party code, because that is what it is. The author's own verification is
recorded, but an author verifying their own unrequested change is exactly the
loop this plan exists to close.

## The five commits

| Commit | Kind | What landed |
|---|---|---|
| `a5377c5` | docs | `wallet` plan: permission seam repointed to the app, mount paths corrected, Phase 3 status fixed, wallet-lock-last rule added |
| `f9b3736` | code | Money amounts bounded to the `numeric(12,2)` ceiling; cumulative balance guard in `applyWalletDelta` |
| `beab675` | code | Audit metadata on the 3 wallet mutations; `q` search actually applied; portal sort order honoured |
| `ac9a7cc` | code + **migration** | Two ledger CHECK constraints; `0010_add_wallet_ledger_checks.sql`, **already applied to the database** |
| `f756dca` | code + test | POS `refundSale` row lock, atomic stock restore, refund double-submit regression test |

## Known-open verification gaps carried in

These are stated by the authoring session itself and must not be taken on
trust — confirm each independently:

1. **`test:wallet-concurrency` was never re-run after `ac9a7cc`.** It passed
   twice before the constraints landed, then the shared `TEST_DATABASE_URL`
   was being dropped/recreated by a concurrent session and the run could not
   complete. So the wallet concurrency proof is **stale relative to the
   shipped schema**.
2. **The check constraints are inert in the test harness.** `tableDdl()` in the
   concurrency tests does not emit CHECK constraints, so `0010`'s guarantees are
   not exercised by any automated suite.
3. **No `wallet` e2e spec exists.** `apps/chrono-web/e2e/tests/` has no `wallet`
   directory. `.ai/rules/e2e-testing.md` makes this mandatory for a
   tenant-scoped feature. Owed by the `wallet` plan, not closed by either
   hardening pass.
4. **Workspace typecheck was red at the time of the last commit**, from an
   unrelated in-progress `voucher/routes.ts` in another session — so "typecheck
   clean" was only ever confirmed for the touched modules, never workspace-wide.

---

## Phase 1 — Re-verify the wallet money bounds (`f9b3736`)

**What to check**

- `moneyAmountSchema` / `signedMoneyAmountSchema` in
  `apps/chrono-api/src/modules/wallet/contracts.ts` cap the integer part at 10
  digits — confirm the ceiling matches `numeric(12,2)` (precision 12 − scale 2 =
  10 integer digits, max `9999999999.99`).
- The cumulative guard in `applyWalletDelta`
  (`apps/chrono-api/src/modules/wallet/service.ts`) is positioned **before** both
  the `UPDATE` and the ledger `INSERT`, so a rejected write leaves no partial
  state.
- It is a **magnitude** check (`> MAX` and `< -MAX`), because an `adjustment`
  may legitimately drive the balance negative. A one-sided check would silently
  break corrections.
- No `Number()` arithmetic on a money value was introduced. The two `Number()`
  calls in `contracts.ts` are zero-comparisons on regex-bounded strings —
  confirm they are still only that.

**Assert by test, not by reading:** an 11-integer-digit amount is a 422 (not a
500); `9999999999.99` is still accepted; a credit that would push an existing
balance past the ceiling is a 422.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`

---

## Phase 2 — Re-verify the wallet route changes (`beab675`)

**What to check**

- All three `recordStaffAudit` calls carry `metadata` with amount, both
  balances, transaction id, member id, reason.
- **The `q` search is applied to the count query as well as the rows query.**
  This is the subtle one: if only the rows query filters, `meta.totalItems`
  describes the unfiltered set and the pagination controls disagree with the
  table. Confirm the `innerJoin` was added to the count query too.
- Portal `/history` applies the requested `order` rather than echoing one it
  does not honour.
- The `ilike` pattern interpolates user input — confirm it is a bound parameter
  (it is a Drizzle value, not string-concatenated SQL) and that a `%`-stuffed
  `q` only widens a search within the caller's own tenant.

**Assert by test:** a search returns a filtered list whose `meta.totalItems`
matches the filtered count; `order=asc` returns ascending rows.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`

---

## Phase 3 — Re-verify the ledger constraints and close the migration gap (`ac9a7cc`)

The highest-risk of the five, because a migration already ran against the
database.

**What to check**

- `apps/chrono-api/drizzle/0010_add_wallet_ledger_checks.sql` contains exactly
  two `ADD CONSTRAINT` statements and no destructive operation.
- **The live database matches the schema file.** Query `pg_constraint` for
  `chrono_wallet_transaction_balance_ck` and `_type_ck` on
  `"ChronoWalletTransactions"` and confirm both exist and their definitions
  match `apps/chrono-api/src/modules/wallet/schema.ts`. A drift here is worse
  than a missing constraint, because `db:generate` would then try to re-add it.
- `pnpm --filter @agora/chrono-api db:generate --name recheck_noop` produces an
  **empty** migration — proving schema file and database agree. Delete the
  generated file afterwards; do not commit it.
- The invariant expression is right: `balanceAfter = balanceBefore + amount` in
  exact `numeric` arithmetic, all three columns `NOT NULL` so the check cannot
  NULL-pass.
- **No planned future writer needs to violate it.** A reversal or transfer is
  still a signed delta, so it holds — but confirm against the `sessions`,
  `credits`, and `pos` plans before accepting.

**Close gap #2:** decide whether `tableDdl()` in the concurrency harnesses
should emit CHECK constraints. Today it does not, so `0010` is untested by any
suite. Either extend the emitter, or record explicitly that these constraints
are production-only guards verified by the manual probe below.

**Assert by test:** a hand-written `INSERT` with a wrong `balanceAfter` is
rejected by name; one with `type = 'transfer'` is rejected by name.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency` — **this is gap #1;
  it must run to completion on a quiet tree, expect 4 passed**

---

## Phase 4 — Re-verify the POS refund fix (`f756dca`)

**What to check**

- `refundSale`'s first statement locks the `chronoSale` row with
  `.for("update")` and re-checks `status` **after** the lock is held.
- Stock restore is an in-place `stockQuantity + n` SQL update, not a
  read-then-write.
- Stock restore runs **before** `creditWallet`, so the wallet lock is acquired
  last per the rule in `.ai/plans/chrono/active/wallet/README.md`. Confirm the
  ordering is deliberate and documented in the code comment, not incidental.
- The refund path's `and(eq(id), eq(trackStock, true))` predicate correctly
  skips non-stock-tracked products — the previous code did this with a
  `!product?.trackStock` guard, so confirm behaviour is preserved for a product
  whose `trackStock` was toggled off after the sale.

**Re-run the negative test.** The authoring session reported that removing
`.for("update")` made all 10 concurrent refunds succeed and credited the wallet
10× (90.00 → 190.00 instead of 100.00). Reproduce that independently: it is the
only evidence the test is not vacuous, and a test that passes either way proves
nothing (`.ai/rules/rbac.md`'s gate-test discipline, applied to a concurrency
guard).

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:pos-concurrency` — expect 6 passed

---

## Phase 5 — Re-verify the plan/doc corrections (`a5377c5`)

Documentation, but it changed instructions a future implementer will follow.

**What to check**

- The `wallet` plan's permission section names
  `apps/chrono-api/src/auth/permissions.ts` + `registerAppPermissions()`, and
  `grep -rn "packages/agora/src/auth/permissions" .ai/plans/chrono/active/wallet/`
  returns nothing.
- The documented route mounts match `rpc.ts` / `app.ts` as actually written.
- The Phase 3 status row agrees with `git log`.
- **The lock-ordering rule is stated unambiguously** — "acquire the wallet lock
  last; never hold it across an external call" — and check it against the
  `sessions` and `credits` plans, both of which the audit found currently
  violate it. If those plans are corrected later, this rule is the thing they
  will be corrected *against*, so its wording matters.

**Verification:** read-back; no commands.

---

## Phase 6 — Close the outstanding e2e gap

Gap #3. Not introduced by these five commits, but neither the `wallet` plan nor
either hardening pass closes it, and it is mandatory.

**Deliverable:** `apps/chrono-web/e2e/tests/wallet/wallet.spec.ts` covering the
happy path (staff tops up a member's wallet, balance and history update), the
role gate (a `staff` actor is refused `wallet:adjust`, which `admin` can
perform), and cross-tenant isolation (a tenant-A actor cannot read or mutate a
tenant-B member's wallet — expect 404, no existence leak).

Per `.ai/rules/e2e-testing.md` this is required for every tenant-scoped
feature. Note the Chrono e2e runner is `pnpm --filter @agora/chrono-web e2e`
(the script is `e2e`, not `test:e2e`), and the Playwright config runs headed
against a running `pnpm dev`.

---

## Environmental preconditions

Two conditions were interfering when these commits landed. Confirm both are
clear before trusting any result:

- **A quiet tree.** A concurrent session was dropping and recreating tables in
  the shared `TEST_DATABASE_URL` mid-run, producing three different
  "relation … does not exist" failures in a row. Any concurrency suite must be
  run with no other session active, or the result is meaningless.
- **Workspace typecheck green.** It was red from an unrelated in-progress
  `voucher/routes.ts`. Confirm `pnpm typecheck` passes workspace-wide, not just
  for the touched modules.

## Acceptance

Each phase ends in one of two states, recorded in `HANDOVER.md`:

- **Confirmed** — checks pass, evidence recorded (command + result, not "looks
  right").
- **Defect found** — filed against the owning module's plan with file:line
  evidence. Do not fix it inside this plan; this plan verifies, it does not
  remediate.

## Out of scope

- Any new feature work, and any remediation of defects this plan finds.
- The audit findings for other modules — those live in
  `.ai/plans/chrono/active/audit-remediation/` and
  `.ai/plans/chrono/active/security-hardening/`.
- Reverting any of the five commits. The developer has decided to keep them;
  this plan verifies them in place.

## Status: COMPLETE (2026-09-02)

All six phases discharged — see `HANDOVER.md` for the full run log, the real
finding, and the applied remedy.

- **Phases 1–5** (re-verify the five commits) — all green on a quiet tree:
  whole-workspace `typecheck` 7/7, `test:wallet-concurrency` 4/4,
  `test:pos-concurrency` 6/6 (including the three Phase 4 refund assertions,
  independently reproduced as gap #4 required), and the Phase 3 drift check
  (`db:generate` → `No schema changes, nothing to migrate`).
- **Phase 6** (close the wallet e2e gap) — already satisfied:
  `apps/chrono-web/e2e/tests/wallet/wallet.spec.ts` exists (`b337c02`) with all
  three required cases (happy path, role gate, tenant isolation).
- **All four carried-in verification gaps closed.**

**This plan justified itself.** Beyond confirming the five commits, it caught a
defect none of them contained: the dev `chrono` database had silently lost every
foreign key, CHECK constraint, and secondary index to a misdirected test
harness, and `db:generate` cannot detect that class of drift. Rebuilt with
developer approval — 0 → 164 FKs, both wallet CHECK constraints restored, 16/16
migrations applied, `rls:proof` PASS.

Two follow-ups recorded in `HANDOVER.md` and owned by no existing plan: harden
the shared test harness against ever targeting a non-`*test*` database, and
teach `tableDdl()` to emit FKs/CHECKs/partial-index `WHERE` clauses so
harness-created schemas match the real migrations.
