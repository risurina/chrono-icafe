# Chrono — `reconciliation` module

**Depends on:** `shift` (schema + routes landed — `ChronoShifts` exists, including the
`expectedCashAmount`/`differenceAmount` columns added by that plan and deliberately left
`null`, see its own Open Question 2), `pos` (schema landed — `ChronoSales`/
`ChronoSaleItems`/`ChronoSalePayments` exist; routes not yet built, so cash-sale
attribution has nothing to sum until `pos`'s route phase ships — this plan's migration
and query logic are correct regardless, they just compute `0` from an empty table until
then), `wallet` (schema landed — `ChronoWallets`/`ChronoWalletTransactions` exist; this
plan **adds a column** to `ChronoWalletTransactions`, see Schema below). **Soft
dependency on `reports`** — that module reads whatever this plan populates, but neither
plan blocks the other; they can land in either order.

## What this is

This module's entire purpose is to make `ChronoShifts.expectedCashAmount` and
`.differenceAmount` real numbers instead of permanent `null`s. At shift-close time, it
computes "what the till should hold" from every cash-affecting transaction that
happened during that specific shift — POS cash sales, POS cash refunds, and staff-
recorded cash-funded wallet top-ups/payouts — and compares it against what the cashier
counted (`actualCashAmount`, already collected by `shift`'s existing close route). This
is the anti-theft / till-accountability mechanism the product needs; oikos calls the
equivalent surface its "owner anti-theft view."

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff** — closes their own shift exactly as before (`shift`'s existing Close Shift
  dialog), but now sees a live "expected cash" figure computed *before* they type in
  their physical count, so a mismatch is visible immediately rather than discovered
  later by an owner. Staff can also optionally attribute a manual wallet cash movement
  (a customer handing over cash to top up their wallet, or a rare cash payout) to their
  own currently-open shift — see "Wallet cash attribution" in Pass 2.
- **Admin / Owner** — reviews closed shifts' variances tenant-wide (or per-branch), sees
  a breakdown of exactly what contributed to the expected total (cash sales, cash
  refunds, wallet cash in/out), not just the final number — the anti-theft use case
  specifically requires the breakdown, not just a variance figure, so a discrepancy can
  be traced to its source.
- **Customer (portal)** — not applicable; this is an internal cash-accountability
  surface.
- **Platform admin (`/rpc-admin`)** — not built in this pass.

**Workflow:** A cashier opens a shift with ₱2,000 float. Through the shift, they ring up
₱1,500 in cash sales via `pos` (each sale's `shiftId` is set automatically by `pos`'s own
checkout route whenever a CASH tender is present, exactly like `pos`'s plan already
specifies) and take one ₱200 cash top-up for a customer's wallet at the counter — for
that top-up, staff explicitly marks it as a cash-funded transaction against their
current open shift (see Contracts). At end of shift, staff opens **Close Shift**; the
dialog calls a live preview endpoint and shows "Expected: ₱3,700" (2,000 opening + 1,500
cash sales + 200 cash-in) before the cashier even types their count. The cashier counts
₱3,680 in the drawer and enters that as `actualCashAmount`; the close route computes
`differenceAmount = -20` and persists both `expectedCashAmount` and `differenceAmount`
onto the shift row, atomically with the close itself. An owner later opens
**Dashboard → Reconciliation**, filters to shifts with a nonzero variance, and drills
into this shift to see the ₱20 shortfall's contributing lines.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- A staff member marking a wallet mutation as cash-funded when they have **no** open
  shift at all → **409** `"An open shift is required to record a cash-funded wallet
  transaction."` — the exact `requireOpenShiftForCash`-shaped guard `pos`'s own plan
  already establishes for cash sales, reused here for wallet cash movements instead of
  reinvented (see "Wallet cash attribution" below — this is a deliberate, single shared
  guard, not two copies of the same check).
- A staff member closing a shift that isn't theirs and isn't the caller's own open one →
  governed by `shift`'s existing permission (any `shift:close` holder may close any open
  shift — that decision is `shift`'s, not re-litigated here); this plan changes *what*
  gets computed at close, not *who* may close.
- Closing a shift twice → still **409** "already closed" (`shift`'s existing guard,
  unchanged); the expected/difference computation only ever runs once, at the moment of
  the first successful close, and is never recomputed afterward (see "Immutability of
  the computed figures" in Pass 2).
- The breakdown/detail route requested for a shift belonging to another tenant → **404**,
  never 403, same discipline as every prior module.
- **Tenant-isolation leak scenario**: tenant A's shift-close cash math must never read a
  cash-sale or wallet row belonging to tenant B — every aggregation query is inside
  `withTenant(tenantId, ...)`, and every join carries an explicit `tenantId` predicate in
  addition to relying on RLS, matching `pos`'s own defense-in-depth precedent.
- A shift closed **before this module ships** (i.e. an existing row with
  `expectedCashAmount: null`) — this plan does not backfill historical shifts; they keep
  showing "—" exactly as `shift`'s UI already renders for a `null` value. Backfilling is
  explicitly out of scope (see Out of Scope) because the underlying cash-sale/wallet rows
  for those old shifts may not have reliable `shiftId` attribution if `pos`/`wallet`
  routes didn't exist yet when they were open.

**Audit / notifications:** the shift-close audit event (`shift.closed`, already written
by `shift`'s own route) is extended to include `expectedCashAmount`/`actualCashAmount`/
`differenceAmount` in its payload — matching `wallet`'s "an amount must be in the audit
entry, not just the action name" principle, applied to the three cash figures instead of
one. The wallet cash-attribution flag on a manual credit/debit is captured in that
transaction's existing `wallet.credited`/`wallet.debited` audit event (already written
by `wallet`'s own routes) via its `shiftId` field, not a new audit action. No new
standalone audit action is introduced by this plan.

---

## Pass 2 — Technical Planning

### Design weaknesses found in oikos — and why this plan diverges from each one

Research against `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/modules/
reconciliation/service.ts`, `modules/reports/cashier.service.ts`, and
`modules/wallet/routes.ts` surfaced three concrete, documented problems in oikos's own
implementation — not stylistic nitpicks, but load-bearing correctness gaps its own code
comments admit to. This plan does not replicate any of them:

1. **oikos's `Payment.shiftId` is inconsistently populated, and its own reports code
   knows it.** `modules/reports/cashier.service.ts`'s top-of-file comment states plainly:
   *"`Payment.shiftId` is NOT reliably populated (`payments/service.ts#createPayment`
   never sets it), so shifts are never joined by `shiftId`. Instead every payment ... is
   attributed to a shift by branch + time window ... A payment ... whose `paidAt` falls
   outside every shift interval ... lands in the `unattributed` bucket instead of being
   dropped."* This is a real design failure: the *correct*, precise per-shift
   attribution mechanism (`shiftId`) exists in the schema but is unreliable, so the
   reporting layer had to build a second, fuzzier heuristic (a branch+time-window join)
   with its own escape hatch (an "unattributed" bucket) for cash that fell through the
   cracks — a strictly worse, harder-to-audit design for exactly the anti-theft use case
   this module exists for. **This plan's divergence**: `pos`'s checkout route (already
   specified in its own plan) sets `ChronoSales.shiftId` unconditionally whenever a CASH
   tender is present, at write time, inside the same transaction as the sale itself —
   never optional, never backfilled by a heuristic later. Every aggregation in this plan
   joins on `shiftId` directly and never falls back to a time-window guess. There is no
   "unattributed" bucket in this plan's design, because there is nothing left
   unattributed.
2. **oikos's `reconciliation/service.ts` documents the *same* bug from the other side**:
   its `calculateExpectedCash`'s own doc comment admits the `from`/`to` window form "can
   double-count across overlapping cashier shifts" and calls `shiftId`-scoped usage
   merely "preferred," not enforced — the code still accepts and runs the unsafe
   fallback. **This plan's divergence**: there is no time-window fallback mode at all.
   Every expected-cash computation in this plan takes exactly one required parameter,
   `shiftId`, and reads only rows carrying that exact `shiftId` — the double-counting
   failure mode is structurally impossible, not merely discouraged.
3. **oikos's cash-tender detail lives in a jsonb blob, not a relational column.**
   `reconciliation/service.ts`'s `cashPortionOf()` has to reach into
   `Payment.metadataJson.payments[]` to find the actual cash amount within a split-tender
   sale, because oikos's `Payment` table only has one `paymentMethod` field for what may
   be a multi-method sale — a direct instance of the same "generic jsonb blob instead of
   a real table" anti-pattern the `pos` plan already found and rejected for the sale/
   cart-line shape itself (see `pos`'s own "Critical scope finding"). **This plan's
   divergence**: this is already fixed upstream — `ChronoSalePayments` is a proper
   relational table with its own `method` column per tender row (one row per payment
   method in a split-tender sale), landed by `pos`'s schema. This plan's cash-sum query
   is a plain `WHERE method = 'cash'` filter, no jsonb parsing, no per-row branching
   logic to maintain.
4. **oikos never attributes wallet cash movements into its expected-cash figure at
   all**, despite going to the trouble of recording a `shiftId` on a wallet top-up's
   underlying `Payment` row (`wallet/routes.ts`'s `/top-up` handler sets
   `shiftId: shift.id` faithfully). `reconciliation/service.ts`'s `calculateExpectedCash`
   only ever sums `Payment` rows filtered to the sale/payment domain — it never
   distinguishes "this Payment row *is* a wallet top-up" from a POS sale, so a cash
   top-up's `shiftId`-tagged cash **does** get correctly counted (it's still a `Payment`
   row with `paymentMethod: 'CASH'`), but only by accident of oikos's single unified
   `Payment` table, not by deliberate design — nothing in oikos's reconciliation code
   ever mentions wallet top-ups as a distinct concept the reconciliation math is aware
   of, and a cash *payout* from a wallet (money leaving the till, decreasing expected
   cash) has no equivalent code path anywhere in the traced source. **This plan's
   divergence**: wallet cash movements are a first-class, explicit part of the
   computation (see Schema and the expected-cash formula below), covering both
   directions — cash in (a customer's wallet top-up funded by cash at the counter) and
   cash out (a rare cash payout from a wallet) — not an accidental side effect of one
   unified payments table.

### Wallet cash attribution — the schema change this plan makes

`ChronoWalletTransactions` has no way today to say "this particular ledger entry moved
physical cash through a till during a specific shift" — a wallet credit/debit is
member-facing balance bookkeeping only, with no branch or shift context (`ChronoWallet`
itself has no `branchId`; it's tenant-wide, per member). This plan adds exactly one
nullable column:

```ts
// apps/chrono-api/src/modules/wallet/schema.ts — additive change
shiftId: text("shiftId").references(() => chronoShift.id, { onDelete: "set null" }),
```

plus an index: `index("chrono_wallet_transaction_shift_idx").on(t.shiftId)`.

**Semantics, made explicit because this is easy to get subtly wrong:** `shiftId` is set
on a `ChronoWalletTransactions` row **only** when the mutation itself represents physical
cash changing hands at a branch counter during that shift — i.e. only through the two
new wallet-route parameters this plan adds (see Routes below). It is **never** set by a
POS wallet-tender debit (a customer paying for a sale from their existing wallet balance
moves no new cash into or out of the till — that cash movement, if any, was already
counted when the wallet was originally funded), and it is **never** set by an
`"adjustment"`-type transaction (a correction is not a till event). This distinction is
the single most important invariant in this plan — get it wrong and cash gets
double-counted (once when the wallet was topped up in cash, again when that same balance
is later spent at the till) or a real cash movement goes uncounted. A short unit test
(Phase 2) asserts the write-path enforces this invariant, not just documents it: the POS
checkout route (owned by `pos`, unchanged by this plan) must never accept or forward a
`shiftId` parameter to `debitWallet()`.

### Expected-cash formula (the actual computation)

For a given `shiftId`, inside a single `withTenant` transaction:

```
expectedCashAmount =
    shift.openingCashAmount
  + SUM(ChronoSalePayments.amount
        WHERE method = 'cash' AND sale.shiftId = :shiftId AND sale.status = 'completed')
  - SUM(ChronoSalePayments.amount
        WHERE method = 'cash' AND sale.shiftId = :shiftId AND sale.status = 'refunded')
  + SUM(ChronoWalletTransactions.amount
        WHERE type = 'credit' AND shiftId = :shiftId)         -- cash physically taken in
  - SUM(ChronoWalletTransactions.amount
        WHERE type = 'debit' AND shiftId = :shiftId)          -- cash physically paid out

differenceAmount = actualCashAmount - expectedCashAmount
```

A refunded sale's cash portion is **subtracted**, not excluded — a sale rung up and then
refunded within the same shift genuinely did put cash in and then take it back out; both
sides are real till events and this plan's formula reflects both, rather than netting
them out silently by filtering to `status = 'completed'` only (which would hide a
refund's cash-out from the breakdown the anti-theft view needs). `ChronoWalletTransactions
.amount` is already a signed decimal (positive = increase) per `wallet`'s own schema, so
the "credit adds / debit subtracts" framing above is a plain-language restatement of
summing signed amounts filtered by `type`, not two independently-signed sums to reconcile
against each other.

### Immutability of the computed figures

`expectedCashAmount`/`differenceAmount` are computed **once**, at the moment of the first
successful close, and stored on the `ChronoShifts` row exactly like `actualCashAmount`
already is — they are never recomputed on a later read. This mirrors `shift`'s own
"immutable audit trail once created" stance (no `DELETE`, no reopen/edit route) and
matches oikos's own behavior (`calculateExpectedCash` is only ever invoked from the close
flow, never from a report route re-deriving it live) — this is one point where oikos's
behavior is already correct and this plan keeps it, rather than diverging just to
diverge. A closed shift's numbers are a permanent historical record; if `pos`/`wallet`
data referencing that shift is somehow edited afterward (it shouldn't be — both are
append-only ledgers with no update-in-place mutation routes), the shift's stored figures
deliberately do **not** drift with it.

### Pattern to copy (worked examples: `shift`, `pos`, `wallet`)

- `apps/chrono-api/src/modules/shift/routes.ts`'s `.post("/shifts/:id/close", ...)` — the
  exact route this plan modifies in place (see Routes), including its existing
  404/409 guards, which this plan does not touch.
- `apps/chrono-api/src/modules/pos/schema.ts` — `ChronoSalePayments.method`, the
  relational split-tender shape this plan's cash-sum query reads directly (see
  divergence #3 above).
- `apps/chrono-api/src/modules/wallet/schema.ts` — the additive-column pattern (this
  plan's own `shiftId` addition follows the identical shape/index convention already
  used for every other nullable FK in that file).
- `.ai/rules/database.md`'s Migration Workflow — this plan's schema change is a single
  additive column + index, generated via `pnpm db:generate --name
  add_shift_id_to_wallet_transactions`, never `db:push`.

### `APP_TENANT_TABLES`

No new entry — `ChronoWalletTransactions` is already registered; this plan only adds a
column to an existing RLS-forced table, which needs no `APP_TENANT_TABLES` change.

### Contracts — changes to `apps/chrono-api/src/modules/wallet/contracts.ts`

```ts
// Additive fields on the existing credit/debit input schemas:
export const creditWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().max(255),
  // When true, this transaction represents cash physically received at the
  // counter and must be attributed to the caller's own open shift. Omitted/
  // false for a non-cash top-up (bank transfer, GCash, etc. — out of scope
  // for this pass but the flag leaves room for it later).
  cashTendered: z.boolean().optional().default(false),
});

export const debitWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().max(255),
  cashTendered: z.boolean().optional().default(false), // a cash payout
});
```

New file `apps/chrono-api/src/modules/reconciliation/contracts.ts`:

```ts
import { z } from "zod";

export const shiftBreakdownParamsSchema = z.object({ shiftId: z.string().min(1) });

// Response shape (outbound, not Zod-validated per .ai/rules/dto.md):
// {
//   shiftId: string;
//   openingCashAmount: string;
//   cashSales: string;        // sum of completed cash sale payments
//   cashRefunds: string;      // sum of refunded cash sale payments (positive number, subtracted)
//   walletCashIn: string;     // sum of shiftId-tagged wallet credits
//   walletCashOut: string;    // sum of shiftId-tagged wallet debits
//   expectedCashAmount: string | null;  // null only for a still-open shift (live preview)
//   actualCashAmount: string | null;    // null until closed
//   differenceAmount: string | null;
// }
```

### Routes

**Modify** `apps/chrono-api/src/modules/wallet/routes.ts`'s existing `credit`/`debit`
handlers (exact route paths per `wallet`'s own landed plan — check that file's current
shape before editing): when `cashTendered: true`, look up the caller's current open
shift via the same query `shift`'s own `GET /shifts/current` route already runs (reuse
that lookup as a small shared helper, not a copy-pasted query — extract it into
`apps/chrono-api/src/modules/shift/service.ts` if it doesn't already exist as an
importable function, mirroring `pos`'s planned `requireOpenShiftForCash` helper so both
modules call the identical function); if none exists, **409** `"An open shift is
required to record a cash-funded wallet transaction."`; otherwise set the new row's
`shiftId` to that shift's id, inside the same transaction as the balance mutation.

**Modify** `apps/chrono-api/src/modules/shift/routes.ts`'s `.post("/shifts/:id/close",
...)`: after the existing 404/409 guards and before the `update`, run the expected-cash
formula above inside the same `withTenant` transaction, and include
`expectedCashAmount`/`differenceAmount` in the `.set({...})` call alongside the existing
`actualCashAmount`/`closeNotes` fields. Extend the `recordStaffAudit` call's payload
with the three cash figures (see Pass 1's Audit section).

**New** `apps/chrono-api/src/modules/reconciliation/routes.ts`:

```
GET /reconciliation/shifts/:id
  — requirePermission(reconciliation: ["read"])
  — 404 if the shift doesn't belong to the caller's tenant
  — for an OPEN shift: runs the same expected-cash formula live (a preview — this is
    what the Close Shift dialog calls before the cashier types their count) and
    returns expectedCashAmount populated, actualCashAmount/differenceAmount both null
  — for a CLOSED shift: returns the persisted, immutable stored figures (does NOT
    recompute) plus the same line-item breakdown recomputed live for display purposes
    only (the breakdown numbers are derivable from immutable ledger data — cash sales/
    refunds/wallet transactions never change after the fact — so recomputing the
    breakdown for *display* carries no drift risk even though the summary total on the
    shift row itself is never overwritten)
```

No `POST`/`PATCH`/`DELETE` route in this module — it has no entity of its own to mutate;
every write in this plan happens through the existing `wallet` and `shift` routes,
modified in place.

### Permission vocabulary — per-app extension seam

Adds to `apps/chrono-api/src/auth/permissions.ts`'s `CHRONO_PERMISSION_STATEMENTS` (via
`registerAppPermissions()`, **never** `packages/agora/src/auth/permissions.ts` directly):

```ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  reconciliation: ["read"],
} satisfies Record<string, string[]>;

export const CHRONO_STAFF_GRANTS = {
  ...
  reconciliation: ["read"],
};

export const CHRONO_ADMIN_GRANTS = {
  ...
  reconciliation: ["read"],
};
```

**No staff/admin split** — deliberately mirroring `shift`'s own "any staff/admin/owner"
posture rather than `pos`/`wallet`'s admin+-only pattern for corrections. Reasoning: a
staff member closing their own shift needs the live preview to do their job (that's the
whole point of surfacing "expected" before they count cash), and the closed-shift
breakdown is the same anti-theft transparency `shift`'s own list route already gives
every role (its `GET /shifts` route is itself ungated — "a full accountability log, not
'my shifts only'," per that plan). Restricting the breakdown to admin+ would hide from a
staff member the exact evidence that clears or implicates them in a shortfall, which
runs counter to the anti-theft purpose. **Open Question 1**: if the developer wants
staff to only ever see their *own* shift's breakdown (not every staff member's), that's a
route-level filter (`shift.staffUserId === callerId` unless the caller also holds a
higher rank), not a different permission action — flagging for confirmation rather than
silently picking the fully-open interpretation.

The wallet `cashTendered` flag itself needs no new permission — it rides on whichever
permission already gates `credit`/`debit` today (`wallet:credit`/`wallet:debit`, staff+
per that plan's own precedent); this plan does not change who may perform a wallet
mutation, only what gets recorded when they do.

### Web UI

- `apps/chrono-web/src/app/dashboard/shifts/` (existing, from `shift`'s plan) — the
  **Close Shift** dialog now calls `GET /reconciliation/shifts/:id` on open (the shift is
  still `open` at that point) and shows a read-only "Expected cash: ₱X" line above the
  `actualCashAmount` input, so the cashier sees the target before entering their count.
  The shift list/detail view's expected/actual/variance columns (currently always "—" per
  `shift`'s own Open Question 2) now render real figures once a shift closes after this
  module lands.
- `apps/chrono-web/src/app/dashboard/wallet/` (existing, from `wallet`'s plan) — the
  manual credit/debit dialog gains a "Cash tendered at counter" checkbox
  (`cashTendered`), visible only when the caller has an open shift (fetched the same way
  the shift dialog already checks); submitting with it checked while holding no open
  shift is caught server-side (409) as the fallback, matching every other module's
  "client hint, server is the real guard" convention.
- `apps/chrono-web/src/app/dashboard/reconciliation/page.tsx` (new) — admin+-visible
  (via `<Can>`) list of shifts filterable to nonzero-variance only, each row linking to a
  detail view rendering the full breakdown (`cashSales`/`cashRefunds`/`walletCashIn`/
  `walletCashOut` → `expectedCashAmount` vs. `actualCashAmount` → `differenceAmount`),
  built from `agora/ui` `Card`/`Table` primitives — this is the "owner anti-theft view"
  oikos names explicitly, now backed by exact `shiftId` attribution instead of a
  time-window guess (divergence #1/#2 above).

### CRUD & Feedback Contract

| Action | Route | Permission | Notes |
|---|---|---|---|
| Read (preview/breakdown) | `GET /rpc/reconciliation/shifts/:id` | `reconciliation:read` | live for open shifts, immutable-stored for closed ones; 404 cross-tenant |
| Compute (side effect of Close) | `POST /rpc/shifts/:id/close` (modified) | `shift:close` (unchanged) | now also persists `expectedCashAmount`/`differenceAmount`; 409 if already closed (unchanged) |
| Attribute (side effect of wallet mutation) | `POST /rpc/wallets/:memberId/credit`\|`/debit` (modified) | `wallet:credit`/`wallet:debit` (unchanged) | 409 if `cashTendered: true` and caller has no open shift |

No standalone Create/Update/Delete surface — this module modifies two existing write
paths and adds one new read path. Feedback: the Close Shift dialog's existing
`toast.success`/`toast.error` now also surfaces the variance (`toast.success("Shift
closed. Variance: ₱-20.00")` when nonzero, plain "Shift closed." when exactly `0`) —
matching `shift`'s existing feedback convention, extended with the one new fact worth
surfacing. Audit linkage: extends the existing `shift.closed` audit payload (see Pass 1);
no new audit action.

---

## Phase 1 — Schema (`ChronoWalletTransactions.shiftId`)

**Files to Update**
- `apps/chrono-api/src/modules/wallet/schema.ts`
- A new generated migration file under `apps/chrono-api/drizzle/` (or wherever
  `pnpm db:generate` writes for this app — check the existing `wallet`/`shift`
  migrations' location first)

**Step-by-Step Tasks**
1. Read `apps/chrono-api/src/modules/wallet/schema.ts` and `apps/chrono-api/src/modules/
   shift/schema.ts` in full before editing (already read during planning; re-read to
   confirm no concurrent changes landed since).
2. Add the `shiftId` column (nullable, FK → `chronoShift.id`, `onDelete: "set null"`) and
   its index to `chronoWalletTransaction`, exactly as specified in Schema above.
3. `pnpm db:generate --name add_shift_id_to_wallet_transactions` against
   `apps/chrono-api`. Review the generated SQL for correctness (additive column + index
   only, no unexpected drops).
4. `pnpm db:migrate`.

**Acceptance Criteria**
- Migration applies cleanly against the Chrono dev database.
- `pnpm --filter @agora/chrono-api typecheck` passes with the updated schema types.
- The new column is nullable and does not break any existing wallet insert (every
  current caller omits it, defaulting to `null`).

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` — must still print `RLS PROOF: PASS ✅`; this is a
  schema change to an already-RLS-forced table, so re-proof per `.ai/rules/database.md`'s
  "after any schema/RLS/tenancy change" rule even though no new table/policy is added.

**Out-of-Scope**
- Any route change — Phase 2/3.

**Execution Start Point**
- `apps/chrono-api/src/modules/wallet/schema.ts` (read fully, then edit additively —
  do not reorder or rename any existing column).

---

## Phase 2 — Wallet Cash-Attribution Routes

**Files to Update**
- `apps/chrono-api/src/modules/wallet/contracts.ts`
- `apps/chrono-api/src/modules/wallet/routes.ts`
- `apps/chrono-api/src/modules/shift/service.ts` (new, if `GET /shifts/current`'s lookup
  isn't already factored into an importable function — extract it if not)
- `apps/chrono-api/src/modules/wallet/routes.test.ts` (or equivalent — add the invariant
  test)

**Step-by-Step Tasks**
1. Add `cashTendered` (default `false`) to `creditWalletSchema`/`debitWalletSchema` per
   Contracts above.
2. Factor `shift/routes.ts`'s `GET /shifts/current` query (branch + caller + status=open)
   into a small exported function (e.g. `findOpenShiftForStaff(tx, { tenantId, userId,
   branchId })`) if it isn't already one — reused by both this phase and (already
   specified in `pos`'s own plan) the POS checkout route, so the "require an open shift
   for cash" check has exactly one implementation.
3. In the wallet credit/debit handlers, when `cashTendered` is `true`: resolve the
   caller's open shift via that function inside the same transaction; 409 if none;
   otherwise pass `shiftId` into the inserted `ChronoWalletTransactions` row.
4. Write the invariant test from "Wallet cash attribution" above: assert the POS
   checkout code path (owned by `pos`, read-only for this test — do not modify `pos`'s
   files) never sets `shiftId` on a wallet debit it triggers; assert a manual credit/
   debit with `cashTendered: true` and no open shift 409s; assert one with an open shift
   sets `shiftId` correctly.

**Acceptance Criteria**
- A cash-funded top-up with an open shift records `shiftId`; the same call with no open
  shift 409s.
- A non-cash-funded (`cashTendered: false`/omitted) top-up never sets `shiftId`,
  regardless of shift state.
- Existing wallet credit/debit tests (from `wallet`'s own plan) still pass unmodified.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test` (module-local test runner)

**Out-of-Scope**
- The shift-close computation itself (Phase 3) and the new reconciliation read route
  (Phase 4).

**Execution Start Point**
- `apps/chrono-api/src/modules/wallet/routes.ts` (read in full — the exact current
  route paths/handler names for credit/debit before editing).

---

## Phase 3 — Shift-Close Computation

**Files to Update**
- `apps/chrono-api/src/modules/shift/routes.ts`
- `apps/chrono-api/src/modules/shift/service.ts` (the expected-cash formula function
  lives here, importable by both this route and Phase 4's reconciliation route, so the
  two never drift into two slightly different formulas)
- `apps/chrono-api/src/modules/shift/routes.test.ts` (or equivalent)

**Step-by-Step Tasks**
1. Implement `computeExpectedCash(tx, { tenantId, shiftId })` in `shift/service.ts`
   exactly per the formula in Pass 2, reading `ChronoSalePayments`/`ChronoSales`
   (joined) and `ChronoWalletTransactions`, both filtered to the given `shiftId` and
   scoped inside the passed transaction (never a fresh `withTenant` call — this function
   must compose inside the close route's existing transaction).
2. Modify `.post("/shifts/:id/close", ...)` to call it and include the result in the
   `update(...).set({...})`, per Routes above. Extend the `recordStaffAudit` payload.
3. Write a deterministic test seeding: an opening amount, two completed cash sales, one
   refunded cash sale, one card sale (must NOT affect the total), one shiftId-tagged
   wallet credit, one shiftId-tagged wallet debit, one non-shiftId-tagged wallet credit
   (must NOT affect the total) — assert the computed `expectedCashAmount` matches the
   formula exactly, and `differenceAmount` matches `actualCashAmount -
   expectedCashAmount`.
4. Test the immutability guarantee: close a shift, assert its stored figures; confirm no
   route exists that recomputes or overwrites them afterward (a negative test — there is
   no `PATCH /shifts/:id`, so this is really "assert the route doesn't exist," matching
   `shift`'s own "no DELETE" precedent write-up).

**Acceptance Criteria**
- The seeded-data test's computed figures match the formula exactly, including the
  card-sale and non-attributed-wallet-transaction exclusions.
- Closing an already-closed shift still 409s, unchanged.
- `recordStaffAudit`'s `shift.closed` payload includes all three cash figures.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- The new `/reconciliation/shifts/:id` read route (Phase 4) and permission registration
  (Phase 4, since the route needs it — bundle rather than split a route from its gate).

**Execution Start Point**
- `apps/chrono-api/src/modules/shift/routes.ts`'s `.post("/shifts/:id/close", ...)`
  handler (already read in full during planning) — modify in place, do not restructure
  the surrounding route chain.

---

## Phase 4 — Reconciliation Read Route + Permission

**Files to Update**
- `apps/chrono-api/src/auth/permissions.ts`
- `apps/chrono-api/src/modules/reconciliation/contracts.ts` (new)
- `apps/chrono-api/src/modules/reconciliation/routes.ts` (new)
- `apps/chrono-api/src/routes/rpc.ts` (mount `reconciliationRoutes()`)
- `apps/chrono-api/src/e2e/permissions.test.ts` (extend)

**Step-by-Step Tasks**
1. Add `reconciliation: ["read"]` to `CHRONO_PERMISSION_STATEMENTS`/
   `CHRONO_STAFF_GRANTS`/`CHRONO_ADMIN_GRANTS`, per Permission vocabulary above.
2. Implement `GET /reconciliation/shifts/:id` per Routes above, reusing
   `computeExpectedCash` from `shift/service.ts` for the open-shift live-preview branch
   and for the closed-shift breakdown-display recomputation (the stored summary itself
   is read as-is, never overwritten).
3. Mount into `rpc.ts`.
4. Extend `permissions.test.ts`: assert `hasPermission("staff"|"admin"|"owner",
   { reconciliation: ["read"] })` are all `true` (no split, per Open Question 1's
   default); assert an unrecognized role gets `false` (deny-by-default).
5. Add a route-level test: an open shift returns a live preview with
   `actualCashAmount`/`differenceAmount` both `null`; a closed shift returns the
   persisted, immutable figures; a cross-tenant shift id 404s.

**Acceptance Criteria**
- All items in Step 5 pass.
- No regression in `shift`'s or `wallet`'s own existing route tests.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Web UI (Phase 5).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/shift/routes.ts`'s existing route-mounting/`rpc.ts`
  composition pattern before adding the new module — copy the `xRoutes()` factory shape
  verbatim.

---

## Phase 5 — Web UI

**Files to Update**
- `apps/chrono-web/src/app/dashboard/shifts/shifts-client.tsx` (or equivalent — the
  existing Close Shift dialog component from `shift`'s plan)
- `apps/chrono-web/src/app/dashboard/wallet/` (the existing credit/debit dialog from
  `wallet`'s plan)
- `apps/chrono-web/src/app/dashboard/reconciliation/page.tsx` (new)
- Dashboard nav config

**Step-by-Step Tasks**
1. Wire the Close Shift dialog's live-preview call and expected-cash display line, per
   Web UI above.
2. Add the `cashTendered` checkbox to the wallet credit/debit dialog, gated visible only
   when the caller has an open shift.
3. Build the new Reconciliation list + detail pages (admin+-visible via `<Can>`), using
   `agora/ui` `Card`/`Table` primitives only — no raw HTML chrome.
4. Update `shift`'s existing list/detail view's expected/actual/variance columns — they
   already render "—" for `null`; confirm they render real values correctly once
   populated (no separate column-formatting change should be needed if `shift`'s UI
   already handles the non-null case, but verify).

**Acceptance Criteria**
- Staff sees the live expected-cash preview before closing their shift.
- A cash-funded wallet top-up with no open shift shows the 409 error via
  `toast.error`, matching every other module's feedback convention.
- Admin sees the Reconciliation list filterable to nonzero variance, with a working
  drill-down breakdown per shift.
- No raw HTML chrome introduced.

**Verification Commands**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual: `pnpm dev`, close a shift with seeded cash sales/wallet activity as staff,
  review the breakdown as admin.

**Out-of-Scope**
- E2e spec (Phase 6).

**Execution Start Point**
- Read `apps/chrono-web/src/app/dashboard/shifts/` in full (the existing Close Shift
  dialog) before modifying it.

---

## Phase 6 — E2E Spec

**Files to Update**
- `apps/chrono-web/e2e/tests/reconciliation/expected-cash-computation.spec.ts` (new)
- `apps/chrono-web/e2e/tests/reconciliation/role-gate.spec.ts` (new)
- `apps/chrono-web/e2e/tests/reconciliation/tenant-isolation.spec.ts` (new)

**Step-by-Step Tasks**
1. Happy path: open a shift, ring up a cash sale and a cash-funded wallet top-up (via
   API calls if `pos`'s own UI isn't built yet — check its status first), close the
   shift with a matching count, assert `differenceAmount === "0.00"` and the breakdown UI
   shows the right contributing lines. Repeat with a mismatched count and assert the
   correct nonzero variance.
2. Role gate: assert both `staff` and `admin` sessions can read a shift's breakdown (no
   split, per Open Question 1's default) — if the developer resolves Open Question 1
   toward "own shifts only," update this spec to match before running it.
3. Tenant isolation: seed shifts/sales/wallet activity in tenant A and B, assert tenant
   B can never read tenant A's shift breakdown (404 on a direct cross-tenant id), and
   tenant A's expected-cash figure never includes tenant B's transactions even if both
   happen to reuse the same `shiftId`-shaped random id space (they can't, in practice,
   since ids are `createId()`-generated, but the isolation assertion should be explicit
   about *why* it can't leak — RLS + `withTenant`, not just id randomness).

**Acceptance Criteria**
- All three specs pass headed against `pnpm dev`, per `.ai/rules/rbac.md`'s manual
  Playwright convention.

**Verification Commands**
- `pnpm dev` (kept running)
- `pnpm --filter @agora/chrono-web test:e2e -- reconciliation`

**Out-of-Scope**
- Nothing further — this is the module's last phase.

**Execution Start Point**
- Read an existing e2e spec for a money-adjacent module (`wallet` or `pos`, whichever
  has one first) for the faker-based cash/amount test-data convention before writing.

---

## Open Questions

1. **Breakdown visibility scope** (Pass 2, Permission vocabulary): should
   `reconciliation:read` let staff see every shift's breakdown (this plan's default, for
   anti-theft transparency), or only their own? A one-line route filter either way — flag
   before Phase 4 ships, don't silently pick one without the developer's sign-off given
   the anti-theft framing cuts both ways (transparency helps innocent staff, but also
   lets a dishonest one see exactly what's being checked).
2. **Non-cash wallet funding methods** (Contracts): `cashTendered` is a boolean today
   because this pass has no other funding-method concept for a wallet top-up (bank
   transfer, GCash, etc. are not modeled anywhere in Chrono yet). If a future plan adds
   real funding-method tracking to `wallet`, this boolean should be superseded by
   whatever that plan introduces, not carried forward as legacy — noting so a future
   session doesn't treat it as load-bearing beyond this pass's scope.

## Out of Scope (this plan)

- Backfilling `expectedCashAmount`/`differenceAmount` on shifts closed before this
  module existed — those rows keep showing `null`/"—"; their underlying cash-sale/
  wallet data may predate reliable `shiftId` attribution anyway (see Pass 1's failure
  cases), so a backfill would be guessing, not reconciling.
- A DB-level constraint enforcing the `cashTendered`-implies-`shiftId` invariant (e.g. a
  `CHECK` tying `ChronoWalletTransactions.shiftId IS NOT NULL` to some marker column) —
  this plan enforces it at the application layer only (Phase 2's route guard + test),
  matching the level of rigor `shift`/`pos`/`reservation` all use for their own
  transactional invariants (app-level guard, proven with a test, not a DB constraint) —
  flagging as a real, accepted tradeoff, not an oversight, since a stricter DB-level
  guarantee is possible but adds meaningfully more schema complexity for a value this
  plan's tests already cover.
- Multi-currency reconciliation — `wallet`'s own `currency` column defaults to a single
  value tenant-wide today; this plan inherits that scope, doesn't extend it.
- Any report/dashboard visualization of reconciliation trends over time (e.g. "average
  variance by cashier over the last month") — that's `reports`' territory if the
  developer wants it there; this plan only builds the per-shift breakdown itself.
- Employee accountability workflows beyond visibility (e.g. auto-flagging a cashier
  after N shortfall shifts, requiring manager sign-off on a variance) — no such workflow
  exists in oikos either; a real but separate feature if wanted later.
- `Payment`-table-style unification of `pos`/`wallet` cash events into one physical-cash
  ledger table — this plan deliberately keeps `ChronoSalePayments` and
  `ChronoWalletTransactions` as two separate, properly-typed tables and computes the
  cash total by querying both, rather than merging them into one generic table the way
  oikos's `Payment` does (see divergence #3's broader point) — a unified ledger is not a
  clear improvement here and would re-introduce exactly the kind of "one table for
  several different things" ambiguity this plan's divergences are all reacting against.
