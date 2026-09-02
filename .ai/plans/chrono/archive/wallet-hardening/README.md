# Chrono — `wallet-hardening`

**Depends on:** `wallet` (Phases 1–3 landed and committed — `f75da47` schema/RLS,
`a4ca2f5` contracts + money helper, `74a6881` service/routes/permission gates/
concurrency proof). This plan does **not** re-open those phases; it closes the defects a
post-implementation audit found in the committed code, plus three factual errors in the
`wallet` plan's own text that would mislead whoever picks up its remaining Phases 4–5.

**Does not block `wallet` Phase 4 (web UI) / Phase 5 (e2e).** Phase 1 here (docs) should
land before Phase 4 is delegated, because the stale plan text is what a delegated agent
reads. Phases 2–4 here are independent of the UI work and can land in either order.

## What this is

`wallet` shipped its core guarantee correctly — the audit confirmed tenant isolation,
the `SELECT … FOR UPDATE` row lock, BigInt-cents money math, the `requireTenantMember`
check inside the tenant transaction, and permission gates on the resolved set. This plan
fixes what it shipped *around* that core: an audit trail that records no amounts, an
unbounded amount that turns a `numeric(12,2)` overflow into a 500, a search parameter
the API accepts and ignores, a pagination contract that reports a sort order it does not
apply, and a ledger invariant enforced only in application code.

---

## Pass 1 — Workflow Analysis

**Who is affected:**

- **Owner / Admin reading the audit trail** — today a `chronoWallet.credited` entry
  names the wallet but not the amount, the balance before/after, or the reason. Someone
  investigating "who moved this member's money and how much" has to join the audit row
  to the ledger by timestamp to answer it. The `wallet` plan explicitly required the
  amount be in the audit row (README.md:609-612); the implementation dropped it.
- **Staff on the wallets list** — the Phase 4 UI will render a `DataTableToolbar` search
  box (per `.ai/rules/data-listing.md`) wired to `q`. `GET /rpc/wallets` validates `q`
  and then ignores it, so the box will silently return unfiltered results. This is a
  defect the UI phase would otherwise inherit and be blamed for.
- **Staff entering an amount** — a fat-fingered `999999999999` passes Zod, reaches
  Postgres, violates `numeric(12,2)`, and surfaces as an unhandled 500 rather than a
  readable 422. Same for a legitimate amount that overflows the balance *cumulatively*.
- **Customer on the portal history** — asking for `order=asc` returns descending rows
  with `meta.order: "asc"`. A contract lie in a financial history view.
- **Whoever builds `sessions`** — `sessions` will call `debitWallet(tx, …)` inside a
  transaction that also locks a station/session row. The `wallet` plan hands it an
  unqualified "call it inside your tx" contract with no lock-ordering rule, so two
  transactions taking `{station, wallet}` in opposite orders deadlock.

**Failure cases addressed:** unhandled 500 on out-of-range input; silent no-op search;
audit trail insufficient for a financial investigation; contract/response mismatch on
sort order; cross-module deadlock; a direct DB writer (future webhook, backfill,
`sessions`) corrupting the ledger invariant with no DB-level guard.

**Not a security issue.** None of these widen tenant isolation or a permission gate. The
audit re-verified both and found them correct.

---

## Pass 2 — Technical Planning

### Finding 1 — Plan text names the wrong permission file

`.ai/plans/chrono/active/wallet/README.md:522-528` shows the new resource being added to
`packages/agora/src/auth/permissions.ts`, and README.md:727-729 + :813 name that file in
Phase 3's Files-to-Update and as its Execution Start Point.

That violates root `AGENTS.md` non-negotiable #6, `.ai/rules/business-app.md`
("Permissions: the per-app extension seam"), and `.ai/rules/rbac.md` ("**foundation
resources only**"). The **implementation got it right** — `wallet` is registered in
`apps/chrono-api/src/auth/permissions.ts` via `CHRONO_PERMISSION_STATEMENTS` /
`CHRONO_STAFF_GRANTS` / `CHRONO_ADMIN_GRANTS`, bootstrapped through
`registerAppPermissions()`, and `routes.ts:3` imports the app-local typed
`require-permission` wrapper. Only the plan text is wrong, which is worse than harmless:
it is the committed artifact the next agent follows.

### Finding 2 — Amounts are unbounded at the contract layer

`contracts.ts:3-11`:

```ts
const moneyAmountSchema = z.string().regex(/^\d+(\.\d{1,2})?$/, …).refine(v => Number(v) > 0, …);
const signedMoneyAmountSchema = z.string().regex(/^-?\d+(\.\d{1,2})?$/, …).refine(v => Number(v) !== 0, …);
```

`numeric(12, 2)` holds at most **10 integer digits** (precision 12 − scale 2), i.e. a
maximum of `9999999999.99`. The regexes accept unlimited integer digits, so
`"99999999999.99"` validates, reaches the DB, and raises a Postgres numeric overflow
mapped to a 500.

Two guards are needed, at different layers:

- **Per-amount**, at the contract: cap the integer part at 10 digits so a bad input is a
  422 with a readable message.
- **Cumulative**, in `applyWalletDelta`: a series of individually-valid credits can still
  push `balanceAfter` past the column's capacity. Guarded in the service, where
  `balanceAfter` is already computed from the locked row.

The cumulative guard belongs beside the existing `isNegativeMoney(balanceAfter)` check —
same place, same shape, same `HttpError(422, …)`.

### Finding 3 — Audit rows carry no amount or resulting balance

`routes.ts:164-168`, `:194-198`, `:223-227` pass only `action` / `targetType` /
`targetId`. `recordStaffAudit` accepts a `metadata` field
(`packages/agora/src/audit/index.ts:149-154`), and sibling Chrono modules already use it
(`apps/chrono-api/src/modules/reservation/routes.ts:271, 341, 380`) — so this is a
one-field addition matching existing precedent, not new plumbing.

The service already returns everything needed: `result.wallet`, `result.transaction`
(which carries `amount`, `balanceBefore`, `balanceAfter`, `reason`, `id`).

### Finding 4 — `q` is accepted and ignored on `GET /rpc/wallets`

`routes.ts:53` validates `listQuerySchema(["balance", "createdAt"])`, which includes `q`.
`routes.ts:57` destructures only `{ page, pageSize, sort, order }`. The
`innerJoin(base.tenantMember, …)` at `:76` is already present, so the searchable columns
(`tenantMember.name`, `.email`) are in scope — the filter just needs applying to **both**
the count query at `:63` and the rows query, or the pagination meta will disagree with
the filtered rows.

Note `:63`'s count currently has no join at all; adding a search predicate over
`tenantMember` requires the join on the count query too.

`.ai/rules/data-listing.md` requires server-side search once a resource is
server-paginated, so this is a rule compliance gap, not just a UX one.

### Finding 5 — Portal `/history` reports a sort order it does not apply

`portal-routes.ts:72` hardcodes `.orderBy(desc(chronoWalletTransaction.createdAt))`, but
`:80` passes the client's `order` into `buildPaginationMeta`. The staff route already
does this correctly (`routes.ts:118`: `const sortFn = order === "asc" ? asc : desc`) —
this is applying the same three-line pattern to the portal route.

### Finding 6 — Ledger invariant has no DB-level guard

`balanceAfter = balanceBefore + amount` is the plan's "self-checking invariant"
(`wallet` README.md:386-387), enforced today only in `applyWalletDelta`. `type` is
likewise constrained only by Zod. A future direct writer — a webhook, a backfill, or
`sessions` calling the service incorrectly — is unguarded.

Two `CHECK` constraints on `ChronoWalletTransactions`, added by migration:

- `balanceAfter = balanceBefore + amount`
- `type IN ('credit', 'debit', 'adjustment')`

`.ai/rules/database.md` requires constraints be defined at the DB level, and requires the
generate-and-migrate flow (never `db:push`). Drizzle expresses these via `check()` in the
table's extras array. This is a schema change, so `rls:proof` re-runs after it.

**Risk to check before writing the migration:** if any existing row violates either
constraint, `ALTER TABLE … ADD CONSTRAINT` fails. Phase 4 verifies the table is clean
first (it should be — every row to date was written by `applyWalletDelta`).

### Finding 7 — No lock-ordering rule for `sessions`

`lockWalletForUpdate`'s `onConflictDoNothing` vivify path **blocks on the inserting
transaction until it commits**. Combined with `sessions` locking a station row in the
same transaction, this gives two hazards:

- Classic ABBA deadlock if one transaction takes `{station, wallet}` and another takes
  `{wallet, station}`.
- A long-running session transaction that vivifies a wallet stalls every concurrent
  counter top-up for that member for the duration.

Neither is a defect in the committed wallet code — it is a missing contract. The fix is a
documented rule in the `wallet` plan's handoff section, adopted by `sessions` when it is
built: **always acquire the wallet lock last, and never hold a wallet lock across an
external call.**

### Out of scope

- `wallet` Phase 4 (web UI) and Phase 5 (e2e browser spec) — still owned by the `wallet`
  plan. The e2e spec remains a required deliverable there; nothing in this plan replaces
  it.
- The unified cash + credit-lot + rewards wallet surface — a separate plan.
- Any change to wallet scoping, the row-lock mechanism, permission grants, or the
  cash-only scope decision. All re-verified as correct.
- `credits` / `loyalty` / `sessions` module work.

---

## Phase 1 — Correct the `wallet` plan and handover

Documentation only, no code. Lands first so a delegated Phase 4/5 reads accurate text.

**Files to update**

- `.ai/plans/chrono/active/wallet/README.md` — four corrections:
  1. "Permission vocabulary" section (~:522-528): replace the
     `packages/agora/src/auth/permissions.ts` code block with
     `apps/chrono-api/src/auth/permissions.ts`, showing
     `CHRONO_PERMISSION_STATEMENTS` / `CHRONO_STAFF_GRANTS` / `CHRONO_ADMIN_GRANTS` and
     the `registerAppPermissions()` bootstrap. Add one sentence stating `packages/agora`
     is not touched by this module.
  2. Mark **Open Question 1 resolved**: `staff` holds `wallet: ["read","credit","debit"]`,
     `admin`+ adds `adjust` — as shipped in `74a6881`.
  3. Phase 3 Files-to-Update (~:727-729) and Execution Start Point (~:813): same file
     correction as (1).
  4. Route mount paths (~:475, :739): plan says `.route("/wallets", walletRoutes())` with
     inner paths `/` and `/:memberId`; the code mounts `.route("/", walletRoutes())`
     (`rpc.ts:1382`) with full `/wallets/...` paths declared inside `routes.ts`.
     Endpoints are identical — correct the plan to match the code.
  5. Add a **lock-ordering rule** to the `sessions` handoff section (Finding 7): wallet
     lock acquired last; never held across an external call.
- `.ai/plans/chrono/active/wallet/HANDOVER.md` — correct the Phase 3 status-table row
  from `not started` to `done` with commit `74a6881`; the log entry below it is already
  correct and stays. Add a log line recording that this hardening plan owns the audit
  follow-ups.

**Acceptance criteria**

- `grep -rn "packages/agora/src/auth/permissions" .ai/plans/chrono/active/wallet/`
  returns nothing.
- The HANDOVER status table and its own log agree on Phase 3.
- The plan's documented route paths match `rpc.ts` / `app.ts`.

**Verification:** read-back only, no commands.

**Execution start point:** `.ai/plans/chrono/active/wallet/README.md`, "Permission
vocabulary" section.

---

## Phase 2 — Bound money amounts (contract + cumulative)

**Files to update**

- `apps/chrono-api/src/modules/wallet/contracts.ts` — cap the integer part at 10 digits
  in both `moneyAmountSchema` and `signedMoneyAmountSchema`
  (`/^\d{1,10}(\.\d{1,2})?$/` and `/^-?\d{1,10}(\.\d{1,2})?$/`), with a message naming
  the maximum. Export a `MAX_BALANCE` constant (`"9999999999.99"`) for the service.
- `apps/chrono-api/src/modules/wallet/service.ts` — in `applyWalletDelta`, beside the
  existing `isNegativeMoney(balanceAfter)` guard, add a cumulative ceiling check on
  `balanceAfter` against `MAX_BALANCE`, throwing
  `HttpError(422, "Wallet balance limit exceeded")`. Uses the existing BigInt-cents
  helpers — no `Number()` arithmetic.

**Step-by-step**

1. Tighten both regexes; keep the existing `.refine` zero/positive checks unchanged.
2. Add `MAX_BALANCE` to `contracts.ts` and import it in `service.ts`.
3. Add the ceiling guard after `balanceAfter` is computed from the locked row, before
   the update and ledger insert — so a rejected write leaves no partial state.

**Acceptance criteria**

- `POST /rpc/wallets/:memberId/credit` with `amount: "99999999999.99"` → **422**, not
  500.
- Crediting a wallet already at `9999999999.99` → 422 with the ceiling message.
- `"9999999999.99"` itself is still accepted as a valid amount.
- Existing insufficient-balance 422 behaviour unchanged.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`

**Out of scope:** changing `numeric(12,2)` itself, or the money helper's internals.

**Execution start point:** `apps/chrono-api/src/modules/wallet/contracts.ts:3`.

---

## Phase 3 — Route correctness: audit metadata, search, sort order

**Files to update**

- `apps/chrono-api/src/modules/wallet/routes.ts` —
  - add `metadata` to all three `recordStaffAudit` calls (`:164`, `:194`, `:223`):
    `{ memberId, amount: result.transaction.amount, balanceBefore, balanceAfter, reason,
    transactionId: result.transaction.id }`, matching
    `modules/reservation/routes.ts:271`'s shape;
  - destructure `q` at `:57` and apply an `ilike` filter over `base.tenantMember.name`
    and `base.tenantMember.email` to **both** the count query (`:63`, which needs the
    `innerJoin` added) and the rows query.
- `apps/chrono-api/src/modules/wallet/portal-routes.ts` — replace the hardcoded
  `desc(...)` at `:72` with `order === "asc" ? asc : desc`, matching `routes.ts:118`;
  import `asc` alongside the existing `desc`.

**Step-by-step**

1. Audit metadata on the three mutation routes.
2. Add the join + `ilike` predicate to the list count and rows queries; apply the same
   `where` to both so `meta.totalItems` matches the filtered set.
3. Portal sort order.

**Acceptance criteria**

- A top-up writes an audit row whose `metadata` contains the amount, both balances, the
  reason, and the transaction id.
- `GET /rpc/wallets?q=<partial name>` returns only matching members, and
  `meta.totalItems` reflects the filtered count — not the unfiltered one.
- `GET /portal/wallet/history?order=asc` returns ascending rows.
- Permission gates and `requireTenantMember` calls untouched.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out of scope:** adding new sort keys; changing the pagination meta shape.

**Execution start point:** `apps/chrono-api/src/modules/wallet/routes.ts:164`.

---

## Phase 4 — Ledger integrity constraints (migration)

Schema change — local only, never delegated, per `.ai/rules/database.md` and the `jules`
skill's guardrail.

**Files to update**

- `apps/chrono-api/src/modules/wallet/schema.ts` — add two `check()` constraints to
  `chronoWalletTransaction`'s extras array:
  `chrono_wallet_transaction_balance_ck` (`"balanceAfter" = "balanceBefore" + "amount"`)
  and `chrono_wallet_transaction_type_ck` (`"type" IN ('credit','debit','adjustment')`).
  Import `check` from `drizzle-orm/pg-core`.
- New migration from `pnpm --filter @agora/chrono-api db:generate --name
  add_wallet_ledger_checks`.

**Step-by-step**

1. **First**, verify no existing row would violate either constraint — a violating row
   makes `ADD CONSTRAINT` fail. Query for
   `balanceAfter <> balanceBefore + amount` and for any `type` outside the three values.
   Expected: zero rows (all writes to date went through `applyWalletDelta`).
2. Add the `check()` entries to the schema.
3. Generate the migration; **read the generated SQL** for destructive operations before
   applying (`.ai/rules/database.md`).
4. Apply with `db:migrate`.

**Acceptance criteria**

- Migration applies cleanly; generated SQL contains only the two `ADD CONSTRAINT`
  statements, no drops.
- A hand-written `INSERT` with a wrong `balanceAfter` is rejected by Postgres.
- `rls:proof` still prints `RLS PROOF: PASS ✅` (non-vacuous).
- `test:wallet-concurrency` still passes — every row it writes satisfies the invariant.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`

**Out of scope:** constraints on `ChronoWallets` itself; backfill or repair tooling
(nothing to repair).

**Execution start point:** the pre-flight violation query in step 1, before any edit.

---

## CRUD & feedback contract

No new entities, no new routes, no CRUD surface change. The only user-visible behaviour
changes are: two new 422s (out-of-range amount, balance ceiling) surfaced verbatim in the
UI's existing error toast, and a search box that now filters. Audit linkage is
*strengthened*, not added — the same three actions, now carrying amounts.

## Verification summary (all phases)

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`
- `pnpm --filter @agora/chrono-api rls:proof` (Phase 4)

## Delegation

Phases 1–3 are small and touch permission-gated financial routes; Phase 4 is a schema
change. **None are delegated to Jules** — Phase 4 by the RLS/schema guardrail, Phases 2–3
because each is a handful of lines in money-moving code where the review cost exceeds the
implementation cost.
