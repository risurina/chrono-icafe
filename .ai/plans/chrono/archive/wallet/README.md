# Chrono — `wallet` module

**Depends on:** `members` (planned, committed `00ef2aa`) — every wallet is anchored to a
`tenantMember.id`. **Status: ready to implement now.** `sessions` (planned last,
separately) depends on this plan's output — a session debit calls the exported
`debitWallet()` helper this plan ships.

## What this is

Chrono's cash-equivalent stored-value balance — the counter-top-up balance a venue
customer spends down as they use the venue (today: staff-recorded manual top-ups/
debits/corrections; later: automatic session-time debits once `sessions` lands). This
plan builds the **cash wallet ledger only** — `ChronoWallets` (one row per member) +
`ChronoWalletTransactions` (an immutable, append-only ledger). It deliberately does
**not** build oikos's separate lot-based time-credit entitlement system (`CreditGrants`
et al.) — see "Critical scope finding" in Pass 2 for why that's a distinct, larger,
not-yet-plannable system, not part of this module.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff / Admin / Owner** — records a manual top-up (cash/card handed over at the
  counter) or a manual debit against a member's wallet, from **Dashboard → Wallets**.
  Admin/Owner additionally records a signed **adjustment** (a correction — e.g.
  reversing a staff mistake) — see Open Question 1 for why `adjust` sits at a stricter
  gate than `credit`/`debit`.
- **Customer (portal)** — views their own current balance and transaction history from
  `/portal`. No self-service top-up in this pass (see Out of Scope — online top-up needs
  a payment-gateway integration, which is the deferred `payments`/`pos` module's job,
  not this one's).
- **Platform admin (`/rpc-admin`)** — not built in this pass, same as `branches`/
  `members`. Out of scope.

**Workflow:** A customer approaches the counter with cash; staff opens
**Dashboard → Wallets**, finds the member (search by name/email), clicks **Top Up**,
enters an amount, confirms — the wallet balance updates immediately and a ledger row is
recorded. A debit (e.g. a manual correction for something not yet billed by `sessions`)
follows the same shape but requires a reason. An admin/owner-only **Adjust** action
records a signed correction (positive or negative) with a mandatory reason, for fixing a
staff mistake without faking a matching credit+debit pair. The customer's `/portal` page
shows the current balance and a scrollable history on next load — read-only, no action
to take there in this pass.

**Failure cases:**

- Unauthenticated staff/customer → blocked by `tenantMiddleware()` / `memberMiddleware()`
  before any Chrono code runs.
- Debit that would take the balance negative → **422**, `"Insufficient wallet balance"`
  (mirrors oikos's `debit` guard) — **except** `adjust`, which is explicitly allowed to
  push the balance negative (it's a correction tool, not a spend; oikos's own manual
  `SUBTRACT` on a credit grant isn't balance-guarded either — see Pass 2).
- Staff attempting `adjust` when only granted `credit`/`debit` → 403, gated by
  `requirePermission` (see Open Question 1).
- Mutating a `memberId` that doesn't belong to the caller's tenant → **404**, never 403
  (no existence leak) — enforced by first looking up the `tenantMember` row **inside**
  the same `withTenant` transaction (RLS-scoped) before touching the wallet, so a
  foreign-tenant id can never auto-vivify a wallet under the wrong tenant (see "Tenant
  isolation leak scenario" below — this is the one genuinely new correctness hazard this
  module introduces relative to `branches`/`members`).
- **Tenant-isolation leak scenario, wallet-specific**: `ChronoWallets.memberId`
  references `tenantMember.id`, and Postgres foreign keys do **not** cross-check that
  the referenced row belongs to the same tenant as the referencing row's own `tenantId`
  column — a naive "look up the wallet by `memberId`, auto-create on miss" implementation
  would let a caller pass tenant B's `memberId` while authenticated as tenant A and
  silently vivify a `ChronoWallets` row stamped `tenantId: A` but pointing at tenant B's
  member. This plan closes that hole explicitly: every mutating route first
  `SELECT id FROM tenantMember WHERE id = :memberId` **inside the caller's**
  `withTenant(tenantId, …)` transaction (RLS-scoped, so a foreign-tenant id returns zero
  rows) and 404s before any wallet read/write. This check is a **required** step in
  every route in Phase 3, not an optional hardening — flagging it prominently because it
  is the one place a copy-paste of the `branches`/`members` pattern would silently miss
  it (those modules never auto-vivify a row keyed off a client-supplied foreign id).
- **Concurrency — the core hazard this plan exists to prevent**: a customer topping up
  at the counter while a session (once `sessions` lands) simultaneously debits the same
  wallet must never lose an update. Two staff members double-clicking "Top Up" on the
  same member must never double-count OR silently drop one of the two. See "Transaction
  integrity mechanism" in Pass 2 — this is proven with a dedicated concurrency test in
  Phase 3, not just asserted in prose.
- Stale screen: two staff viewing the same member's wallet — last write wins on the
  balance (no optimistic lock on `ChronoWallets` itself; the row lock inside the
  transaction is what prevents the race, not client-side staleness detection — matches
  `branches`/`members`' own "last write wins" precedent for non-money fields, but here
  it's specifically the transactional row lock, not just prose, that makes it safe for
  money).

**Audit / notifications:** every `credit`/`debit`/`adjust` writes a `recordStaffAudit`
entry (`chronoWallet.credited` / `.debited` / `.adjusted`) capturing the amount, the
resulting balance, and the reason. No transactional email in this pass (matches
`members`' own "not required to ship the workflow" call) — a "balance changed" email is
a trivial follow-up via `agora/server`'s `sendTransactionalEmail`, not required here.

---

## Pass 2 — Technical Planning

### Critical scope finding — wallet and credits are genuinely different systems (read before the schema)

Oikos research (`apps/chrono-api/src/modules/wallet/**`,
`apps/chrono-api/src/modules/credits/**`,
`apps/chrono-api/src/database/schema/wallet.ts`,
`apps/chrono-api/src/database/schema/credits.ts` in
`C:\Users\ronni\project\izur\oikos`) confirms these are **two separate balance systems,
linked but not merged**, not the same balance under two names:

- **Wallet** (`Wallets`/`WalletTransactions`) — a single scalar cash balance per
  `(tenantId, userId)`, `numeric(12,2)`, currency `PHP`. This is what this plan ports.
- **Credits** (`CreditProducts` / `CreditProductGrantRules` / `CreditPurchases` /
  `CreditGrants` / `CreditGrantLedgerEntries` / `UsageEvents` / `CreditApplications` — 7
  tables) — a **lot-based, non-fungible time/value entitlement ledger**. Each
  `CreditGrants` row is its own batch (e.g. "2 hours from a promo purchase") with a unit
  (`MINUTE`/`PHP`/`POINT`), a `creditPolicy` gating which **device group** it can be
  spent at (`STRICT_GROUP_ONLY`/`CONVERT_BY_VALUE`/`ANY_STATION`), and its own expiry —
  a member's total "credit" is the sum of many such lots, not one column. Session
  billing (oikos's `credit-application.service.ts`) spends **wallet cash first, then
  falls back to time-credit grants** — a real, working, already-built integration in
  oikos, not a stub.

**This plan builds the cash wallet only.** The credits system is excluded, not deferred
by omission but by deliberate cut, because:

1. It structurally depends on concepts that don't exist yet on this side — a
   `DeviceGroup`/pricing-rule concept roughly analogous to (but not necessarily
   identical to) whatever `stations` lands as, plus a whole product-catalog surface
   (`CreditProducts`, grant rules, purchase/void/refund flows). It is not a small
   extension of `wallet` — it is its own module-sized system, on the order of
   `branches`/`stations` in scope, not a sub-feature of a wallet ledger.
2. It has no home in `.ai/handover/chrono-migration.md`'s Wave 1 dependency graph today
   — that graph lists `wallet` as its own node feeding `sessions`; `credits` (the
   lot-based system) appears nowhere in it. Building it now would be scope invented
   mid-plan, which `ai-agent.md` and `feature-planning.md` both warn against.
3. `sessions` (the only Wave-1 module that would consume credits) can be built against
   wallet-only debits first — a flat per-minute/per-session cash debit via
   `debitWallet()` (see below) — with a lot-based time-credit fallback added later as
   its own plan once `stations`/device-grouping actually exists to gate it against.

**Recommendation, not a decision made here**: once `stations` has landed and a real
device-grouping/pricing concept exists, write a separate `credits` plan modeled on this
finding — do not retrofit it into `ChronoWallets`. Flagging this explicitly so it's a
visible, deliberate scope boundary the developer can override, not a gap discovered
later.

**Loyalty points** (`apps/chrono-api/src/database/schema/loyalty.ts` —
`LoyaltyPoints`/`LoyaltyPointTransactions`, integer balance, `EARNED`/`REDEEMED`/
`ADJUSTMENT`) are confirmed **out of scope too** — a third, wholly separate currency,
already on `.ai/handover/chrono-migration.md`'s deferred list. Not touched here. (Also
worth a one-line flag for whoever eventually plans `credits`: oikos itself has two
unrelated "points" concepts — real `LoyaltyPoints.balance` vs. a `CreditGrants` row with
`unit = 'POINT'` — with no FK between them. Don't conflate them later.)

### Transaction integrity mechanism (the load-bearing design decision)

Oikos's `walletService` (`apps/chrono-api/src/modules/wallet/service.ts`) uses
**`SELECT … FOR UPDATE` row-level locking inside a DB transaction**, not an optimistic
version column. `lockWalletForUpdate(tenantId, userId, tx)` is the single choke point
every money mutation goes through: it locks the wallet row (or atomically creates one on
first use via `onConflictDoNothing` + re-select-for-update, tolerating the create-race),
and every `topUp`/`debit` call happens inside `db.transaction(...)`, computing the new
balance from the **locked** row (never a stale pre-transaction read), inserting the
ledger row with `balanceBefore`/`balanceAfter` snapshots, and updating `Wallets.balance`
— all in the same transaction. Money math itself uses BigInt-cents arithmetic
(`core/money.ts`'s `addMoney`/`subtractMoney`), never floats.

**This plan ports the row-lock mechanism, not an optimistic-lock alternative**, because:
(a) it's oikos's own proven, working pattern for this exact problem; (b) Drizzle's
Postgres query builder supports `.for("update")` natively on a `select`, so it's a
direct, idiomatic port — no new library; (c) an optimistic version column would need a
retry loop on every caller (including the future `sessions` debit path), which is more
moving parts for no benefit here — wallet mutations are short, single-row, and contended
only under genuine concurrent top-up/debit, exactly the case row-locking is designed
for.

Every balance mutation in this module funnels through one internal helper:

```ts
// apps/chrono-api/src/modules/wallet/service.ts
async function lockWalletForUpdate(tx: TenantTx, tenantId: string, memberId: string) {
  const [existing] = await tx
    .select()
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, memberId))
    .for("update");
  if (existing) return existing;
  await tx
    .insert(chronoWallet)
    .values({ tenantId, memberId, balance: "0" })
    .onConflictDoNothing({ target: chronoWallet.memberId });
  const [created] = await tx
    .select()
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, memberId))
    .for("update");
  return created!; // present: either it existed, or the insert (ours or a racing one) won
}

async function applyWalletDelta(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    delta: string; // signed decimal string; positive = increase, negative = decrease
    type: "credit" | "debit" | "adjustment";
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
    allowNegative?: boolean; // debit guard escape hatch — only "adjustment" sets this
  },
) {
  const wallet = await lockWalletForUpdate(tx, args.tenantId, args.memberId);
  const balanceAfter = addMoney(wallet.balance, args.delta); // BigInt-cents helper, see money.ts
  if (!args.allowNegative && isNegativeMoney(balanceAfter)) {
    throw new HttpError(422, "Insufficient wallet balance");
  }
  const [updatedWallet] = await tx
    .update(chronoWallet)
    .set({ balance: balanceAfter, updatedAt: new Date() })
    .where(eq(chronoWallet.id, wallet.id))
    .returning();
  const [transaction] = await tx
    .insert(chronoWalletTransaction)
    .values({
      tenantId: args.tenantId,
      walletId: wallet.id,
      memberId: args.memberId,
      type: args.type,
      amount: args.delta,
      balanceBefore: wallet.balance,
      balanceAfter,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      performedByUserId: args.performedByUserId,
    })
    .returning();
  return { wallet: updatedWallet!, transaction: transaction! };
}
```

Three thin, exported wrappers (this is the shared surface `sessions` imports):

```ts
export function creditWallet(tx: TenantTx, args: { tenantId; memberId; amount: string; reason: string; referenceType?; referenceId?; performedByUserId? }) {
  return applyWalletDelta(tx, { ...args, delta: args.amount, type: "credit" });
}

export function debitWallet(tx: TenantTx, args: { tenantId; memberId; amount: string; reason: string; referenceType?; referenceId?; performedByUserId? }) {
  return applyWalletDelta(tx, { ...args, delta: negateMoney(args.amount), type: "debit" });
}

export function adjustWalletBalance(tx: TenantTx, args: { tenantId; memberId; delta: string; reason: string; performedByUserId? }) {
  return applyWalletDelta(tx, { ...args, type: "adjustment", allowNegative: true });
}
```

**This is the helper `sessions` will import**: `debitWallet(tx, { tenantId, memberId,
amount, reason, referenceType: "session", referenceId: sessionId })`, called **inside**
`sessions`' own `withTenant` transaction so a session-close-plus-debit is one atomic
unit — never two separate calls, exactly per this plan's brief. All three functions
require an already-open `tx` (never open their own transaction) specifically so a
calling module can compose them into a larger atomic operation.

**Lock-ordering rule for callers (non-negotiable).** A composing module's transaction
will hold other row locks — `sessions` locks a station/session row in the same `tx` that
debits the wallet. Two transactions acquiring the same pair in opposite orders deadlock,
and `lockWalletForUpdate`'s `onConflictDoNothing` vivify path **blocks on the inserting
transaction until it commits**, so a long transaction that first-touches a wallet stalls
every concurrent counter top-up for that member. Therefore:

1. **Acquire the wallet lock last** — after every other row lock the transaction needs.
   Fixing one global order across all callers is what makes the ABBA deadlock impossible.
2. **Never hold a wallet lock across an external call** (payment provider, device/kiosk
   round-trip, e-mail). Do that work before the debit or after the commit, never between
   the lock and the commit.

`sessions` adopts this rule when it is built; it is not enforceable in the wallet code
itself, which is why it is documented here as part of the exported surface's contract.

**Money math**: a new small helper, `apps/chrono-api/src/modules/wallet/money.ts`,
BigInt-cents arithmetic on decimal strings (`addMoney`, `negateMoney`,
`isNegativeMoney`) — ported from oikos's `core/money.ts` pattern, module-local per
`business-app.md` (promote to `packages/agora` only if a second business app needs
decimal-safe money math). **Never** `Number()`/floating point on `balance`/`amount` —
`.ai/rules/database.md` is explicit on this, and oikos's own `credits` module is a
cautionary example: it locks rows correctly but does its arithmetic via raw
`Number()`/`.toFixed(2)` instead of its own `wallet` module's safe helpers — this plan
does not repeat that mistake.

### What exists today in oikos — schema (source of truth for "what exists")

`apps/chrono-api/src/database/schema/wallet.ts`:

- **`Wallets`**: `id` uuid PK, `tenantId`/`userId` FKs (cascade), **`balance
  numeric(12,2)` NOT NULL default `'0'`** (confirmed decimal, not float), `currency`
  text default `'PHP'`, `status` enum `ACTIVE`/`FROZEN`/`CLOSED` (default `ACTIVE`),
  timestamps. Unique `(tenantId, userId)`.
- **`WalletTransactions`**: `id`, `tenantId`, `branchId` (nullable), `walletId`,
  `userId`, `paymentId`/`sessionId` (nullable FKs to modules not built here), `type`
  enum `TOP_UP`/`PAYMENT`/`REFUND`, `status` enum `PENDING`/`POSTED`/`FAILED`, **`amount
  numeric(12,2)`**, **`balanceBefore numeric(12,2)`**, **`balanceAfter numeric(12,2)`**
  (before/after snapshot pattern), `referenceNo`, `metadataJson`, `createdByUserId`,
  `createdAt`. No idempotency-key column/constraint (a real gap oikos has that this plan
  does not need to solve — Chrono has no retried-request problem yet since there's no
  external payment gateway calling in; flagging only so it isn't assumed fixed).

Route/service surface: `walletService.topUp`/`.debit` (staff manual top-up/debit, POS
checkout line item, and auto-called by `paymentService.markAsPaid`/`refundPayment` when
a standalone Payment transitions), `GET /wallet/balance`/`/history` (member,
`requireMemberAuth`), `GET /wallet/transactions` (staff list, `requireRole(['OWNER',
'STAFF','SUPER_ADMIN'])`), `POST /wallet/top-up`/`/debit` (staff,
`requireRole(['OWNER','STAFF'])` — **note: oikos grants STAFF both top-up and debit**,
only the separate `/payments/:id/refund` route is OWNER-only — see Open Question 1).

### Anchor — `memberId` references `tenantMember.id`, not `chronoMemberProfile.id`

Per the `members` plan (`.ai/plans/chrono/active/members/README.md`), a staff-created
customer (`POST /rpc/customers`, existing, unchanged) does **not** get an automatic
`ChronoMemberProfiles` row — only a self-service "apply for membership" action creates
one. That means a customer can hold a wallet (a staff top-up should work for any
customer, applied-for-membership or not — that's a counter transaction, not a membership
decision) before a `chronoMemberProfile` row exists for them at all. Anchoring
`ChronoWallets.memberId` on `chronoMemberProfile.id` would make wallets impossible for
un-applied customers, which is wrong. This plan anchors on **`tenantMember.id`**
directly, per this task's own guidance for the ambiguous case — it's guaranteed to exist
for every customer the moment their account exists.

### Schema — `ChronoWallets`

New file `apps/chrono-api/src/modules/wallet/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoWallet = pgTable(
  "ChronoWallets",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // One wallet per tenantMember — enforced by the unique index below.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("PHP"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_wallet_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_wallet_member_uq").on(t.memberId),
  ],
);
```

Deliberate differences from oikos's `Wallets`:

- No `status` (`ACTIVE`/`FROZEN`/`CLOSED`) column. Confirmed in research: oikos stores
  this but **never reads it anywhere in the service layer** — a top-up/debit against a
  `FROZEN`/`CLOSED` wallet is not actually blocked by any code path found. This is
  exactly the kind of unused, unenforced field `ai-agent.md`/`rbac.md`'s "unused
  statement/table invites drift" principle warns against porting — same call the
  `members` plan made cutting `memberCode`. If wallet freeze/close becomes a real,
  enforced need later, add it then against the actual enforcement requirement.
- `precision: 12, scale: 2` explicit on the `numeric` column (agora's existing money
  columns — `paymentTransaction.amount`, `plan.monthlyPrice` in
  `packages/agora/src/db/schema/{tenant,platform}.ts` — declare bare `numeric(...)` with
  no precision/scale; this plan is explicit since a wallet balance is a hard financial
  invariant worth pinning at the schema level, matching oikos's own explicit
  `numeric(12,2)`).

### Schema — `ChronoWalletTransactions`

Same file:

```ts
export const chronoWalletTransaction = pgTable(
  "ChronoWalletTransactions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    walletId: text("walletId")
      .notNull()
      .references(() => chronoWallet.id, { onDelete: "cascade" }),
    // Denormalized alongside walletId (mirrors oikos's WalletTransactions.userId) so
    // a member's own transaction history reads without a join.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // Free-text, Zod-validated at the contract layer, not a Postgres enum — matches
    // the dominant agora convention (see branches/members precedent) and avoids the
    // non-idempotent CREATE TYPE migration ceremony for a 3-value field.
    type: text("type").notNull(), // "credit" | "debit" | "adjustment"
    // Signed decimal delta: positive = balance increased, negative = decreased.
    // balanceAfter = balanceBefore + amount, always — this invariant is what makes
    // the ledger self-checking (a corrupted balanceAfter can be caught by replay).
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    balanceBefore: numeric("balanceBefore", { precision: 12, scale: 2 }).notNull(),
    balanceAfter: numeric("balanceAfter", { precision: 12, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    // Free-text categorization of what triggered this row, e.g. "manual_topup" |
    // "manual_debit" | "manual_adjustment" | "session" (future, unenforced today —
    // sessions can start writing this value with zero migration once it lands).
    referenceType: text("referenceType"),
    // Id of the causing entity (e.g. a future sessionId). Deliberately NOT a real FK
    // — it's polymorphic depending on referenceType, and most of its future
    // referents (session) don't exist as tables yet. Mirrors how oikos itself needed
    // several separate nullable FK columns (paymentId, sessionId) for this same
    // "what caused this" concept; a single untyped reference column is the right
    // shape here since Chrono doesn't have those tables yet to FK against.
    referenceId: text("referenceId"),
    // The staff actor who performed a manual mutation. Null for anything triggered
    // without a staff actor (there is none in this pass — every mutation in this
    // plan is staff-initiated — but sessions' future auto-debit will also leave this
    // null, so it's nullable from day one).
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Immutable ledger row — no updatedAt, it is never updated after insert.
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_wallet_transaction_tenant_idx").on(t.tenantId),
    index("chrono_wallet_transaction_wallet_idx").on(t.walletId),
    index("chrono_wallet_transaction_member_idx").on(t.memberId),
    index("chrono_wallet_transaction_type_idx").on(t.type),
    index("chrono_wallet_transaction_created_idx").on(t.createdAt),
  ],
);
```

### `APP_TENANT_TABLES`

Add `"ChronoWallets"` and `"ChronoWalletTransactions"` to the array in
`apps/chrono-api/src/db/schema.ts` (alongside whatever `branches`/`members` have already
added — check the file's current state first; don't clobber a concurrently-landed
entry), and re-export `chronoWallet`/`chronoWalletTransaction` from the module,
mirroring `chronoBranch`'s existing re-export exactly.

### Contracts — `apps/chrono-api/src/modules/wallet/contracts.ts`

```ts
import { z } from "zod";

const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

const signedMoneyAmountSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, "Amount must be a decimal with up to 2 decimal places")
  .refine((v) => Number(v) !== 0, "Adjustment amount must not be zero");

export const walletTransactionTypeSchema = z.enum(["credit", "debit", "adjustment"]);

export const creditWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().min(1).max(255).optional(), // defaults to "Manual top-up" in the route
  referenceType: z.string().max(50).optional(),
});

export const debitWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().min(1).max(255),
  referenceType: z.string().max(50).optional(),
});

export const adjustWalletSchema = z.object({
  delta: signedMoneyAmountSchema,
  reason: z.string().min(1).max(255),
});

export type WalletTransactionType = z.infer<typeof walletTransactionTypeSchema>;
export type CreditWalletInput = z.infer<typeof creditWalletSchema>;
export type DebitWalletInput = z.infer<typeof debitWalletSchema>;
export type AdjustWalletInput = z.infer<typeof adjustWalletSchema>;
```

### Routes — two Hono factories, two audiences (mirrors `members`' shape)

**Staff-facing — `apps/chrono-api/src/modules/wallet/routes.ts`, `walletRoutes()`**
(`TenantVars`, composed into `apps/chrono-api/src/routes/rpc.ts` via
`.route("/", walletRoutes())` — the factory declares its own full `/wallets/...` paths
internally rather than being mounted under a `/wallets` prefix; the resulting endpoints
are identical either way):

- `GET /` — `requirePermission(c.var.tenant.permissions, { wallet: ["read"] })`.
  `zValidator("query", listQuerySchema(["balance", "createdAt"]))`, `withTenant`, joins
  `chronoWallet` → `base.tenantMember` (name/email) so the list can render member
  identity + balance. Members with no wallet row yet are not listed (a wallet only
  exists once a first mutation creates it) — the list is "members with wallet
  activity", not "every member". Returns `{ items, meta }`.
- `GET /:memberId` — `wallet:read`. Returns `{ wallet }` (or a zero-balance placeholder
  if none exists yet — no auto-create on a read) plus a **separate**
  `GET /:memberId/transactions` (paginated via `listQuerySchema(["createdAt"])`) for the
  ledger history, so the detail view and the (potentially long) history list can be
  fetched/paginated independently.
- `POST /:memberId/credit` — `wallet:credit`. First `SELECT id FROM tenantMember WHERE
  id = :memberId` inside `withTenant` — 404 if not found (closes the isolation hole
  described in Pass 1). Validates `creditWalletSchema`, defaults `reason` to `"Manual
  top-up"`, calls `creditWallet(tx, { ..., performedByUserId: c.var.tenant.userId })`.
  `recordStaffAudit({ action: "chronoWallet.credited", ... })`.
- `POST /:memberId/debit` — `wallet:debit`. Same tenantMember existence check. Validates
  `debitWalletSchema`, calls `debitWallet(tx, ...)` — **422** (`HttpError`) if it would
  go negative. `recordStaffAudit({ action: "chronoWallet.debited", ... })`.
- `POST /:memberId/adjust` — `wallet:adjust`. Same tenantMember existence check.
  Validates `adjustWalletSchema`, calls `adjustWalletBalance(tx, ...)` — no
  insufficient-balance guard (a correction is allowed to leave the balance negative,
  matching oikos's own unguarded manual credit-grant `SUBTRACT`).
  `recordStaffAudit({ action: "chronoWallet.adjusted", ... })`.

**Customer-facing — `apps/chrono-api/src/modules/wallet/portal-routes.ts`,
`walletPortalRoutes()`** (`MemberVars`, gated by `agora/member-auth`'s
`memberMiddleware()`, mounted via `.route("/portal/wallet", walletPortalRoutes())` in
`apps/chrono-api/src/app.ts`, mirroring the existing `/portal/members` mount):

- `GET /balance` — returns `{ balance: "0.00", currency: "PHP", exists: false }` if no
  wallet row exists for `c.var.member.memberId` yet (no side-effecting auto-create on a
  read — mirrors oikos's own `emptyWalletBalance()` pattern in `wallet/serializers.ts`),
  or the real row's `{ balance, currency, exists: true }` otherwise.
- `GET /history` — paginated own transaction list (`listQuerySchema(["createdAt"])`);
  empty `{ items: [], meta: ... }` if no wallet exists yet — not an error.

### Permission vocabulary — a new resource, not an extension of `customer`

Unlike `members` (which extended the existing `customer` resource because
`ChronoMemberProfiles` is a 1:1 view of the same rows), wallet mutations are a
**financial** action with a materially different risk profile from identity CRUD —
granting `customer:update` should not implicitly grant "may move money." This plan adds
a wholly new resource, matching `branches`' own precedent:

The resource is registered through the **per-app extension seam**, never by editing
`packages/agora` — see `.ai/rules/business-app.md` ("Permissions: the per-app extension
seam") and root `AGENTS.md` non-negotiable #6. **This module does not touch
`packages/agora` at all.**

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  wallet: ["read", "credit", "debit", "adjust"],
} satisfies Record<string, string[]>;

export const CHRONO_STAFF_GRANTS = {
  ...
  wallet: ["read", "credit", "debit"],
} satisfies Record<string, string[]>;

export const CHRONO_ADMIN_GRANTS = {
  ...
  wallet: ["read", "credit", "debit", "adjust"],
} satisfies Record<string, string[]>;
```

These are registered via `registerAppPermissions()` from
`apps/chrono-api/src/auth-bootstrap.ts`, which every process entrypoint imports before
anything imports `agora/auth`. Route files gate through the app-local typed wrapper
`apps/chrono-api/src/auth/require-permission.ts` (a type-only layer over the identical
runtime `requirePermission`), so `wallet`'s own resource keys are compile-time checked.

**Open Question 1 — RESOLVED (shipped in `74a6881`): `staff` holds
`wallet: ["read", "credit", "debit"]`; `admin`+ additionally holds `adjust`.** The
reasoning that produced that answer is kept below for the record.

**Original question — should `staff` hold `wallet:credit`/`:debit`?** oikos gates its manual top-up/debit routes `requireRole(['OWNER','STAFF'])`
— i.e. **staff can top-up and debit** (this is the day-to-day counter operation at a
gaming café; staff run the till). Only the separate refund/reversal path
(`/payments/:id/refund`) is `OWNER`-only. Every prior Chrono plan (`branches`,
`members`) gated its mutations admin+-only because oikos itself gated the analogous
actions `OWNER`-only there — but wallet is the first resource where oikos's own
precedent is different (STAFF-inclusive for the routine case, owner-only only for the
correction/reversal case). This plan **follows oikos's evidence-based split**:

- `staffRole` — `wallet: ["read", "credit", "debit"]` (day-to-day counter operations;
  matches oikos's `requireRole(['OWNER','STAFF'])` on `top-up`/`debit` exactly).
- `adminRole` — `wallet: ["read", "credit", "debit", "adjust"]` (`adjust` sits above
  staff, mirroring oikos's stricter gate on the correction/reversal path — oikos itself
  is `OWNER`-only there; this plan places it at agora's `admin`+ tier rather than
  literal owner-only, consistent with how `branches` widened oikos's owner-only branch
  CRUD to admin+ to match agora's sibling tenant-configuration resources. If the
  developer wants `adjust` to match oikos's stricter owner-only reversal gate exactly,
  drop `wallet: [...]` from `adminRole` and owner-exclusivity falls out automatically
  from `PERMISSION_STATEMENTS` — a one-line change, same shape as `branches`' Open
  Question 2).
- `ownerRole` — inherits automatically (spreads all of `PERMISSION_STATEMENTS`).

Flagging this prominently since it's the first Chrono plan to grant `staff` a
money-moving action at all — confirm this reading before Phase 3, since it's a real,
deliberate widening relative to every prior Chrono plan's default posture.

### Audit action naming

`chronoWallet.credited` / `.debited` / `.adjusted` — no collision with the existing
`member.*` (Better Auth staff membership + customer DSAR) or `chronoMemberProfile.*`
prefixes already in use (`.ai/plans/chrono/active/members/README.md`'s "Audit action
naming" section flagged the same kind of collision for that module; wallet's prefix is
unambiguous against both).

### Web UI

- **Staff — `apps/chrono-web/src/app/dashboard/wallets/page.tsx` (new)**: mirrors
  `apps/chrono-web/src/app/dashboard/settings/customers/page.tsx`'s structure
  (`useListQuery()`, `DataTable`/`DataTableGrid`/`DataTableToolbar`/`DataTablePagination`
  from `agora/ui`), listing member + balance, with row actions **Top Up** / **Debit** /
  **Adjust** (the last visible only when the session holds `wallet:adjust` — a frontend
  visibility check per `.ai/rules/rbac.md`, never a security boundary) opening a
  `Dialog` form (amount + optional/required reason per action, per Pass 2's contracts).
  A per-member detail view (click a row) shows the paginated transaction history
  (`DataTable` again, columns: type `Badge`, amount, balance after, reason, performed
  by, date).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Wallets` entry to `BASE_NAV`
  (a `Wallet`-style `lucide-react` icon) and `"/dashboard/wallets": "Wallets"` to
  `TITLES`, mirroring the `Projects`/`Branches`/`Members` entries.
- **Customer — extend `apps/chrono-web/src/app/portal/page.tsx` further** (already
  extended once by the `members` plan with a Membership card): add a "Wallet" `Card`
  showing the current balance (`GET /portal/wallet/balance`) and a compact recent-history
  list (`GET /portal/wallet/history`, first page only — a "View all" affordance is out of
  scope for this pass, a plain scrollable list of the first page is enough). New small
  client helper `apps/chrono-web/src/lib/wallet-portal.ts` (`getMyWalletBalance()`,
  `getMyWalletHistory(query)`), mirroring `member-application.ts`'s shape exactly.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List (staff) | `GET /rpc/wallets` | `wallet:read` | paginated, joined with member identity; only members with a wallet row appear |
| Detail (staff) | `GET /rpc/wallets/:memberId` | `wallet:read` | zero-balance placeholder if no row yet |
| History (staff) | `GET /rpc/wallets/:memberId/transactions` | `wallet:read` | paginated |
| Credit / top-up (staff) | `POST /rpc/wallets/:memberId/credit` | `wallet:credit` | auto-vivifies the wallet row on first use |
| Debit (staff) | `POST /rpc/wallets/:memberId/debit` | `wallet:debit` | 422 if it would go negative |
| Adjust (staff) | `POST /rpc/wallets/:memberId/adjust` | `wallet:adjust` | signed delta, no balance guard, mandatory reason |
| Balance (customer) | `GET /portal/wallet/balance` | member session | `{ exists: false }` placeholder if none yet |
| History (customer) | `GET /portal/wallet/history` | member session | empty list if none yet |
| Delete | — | — | not built this pass — deleting the `tenantMember` (existing `DELETE /rpc/customers/:id`) cascades both `ChronoWallets` and `ChronoWalletTransactions` via FK; no standalone wallet delete |

Feedback: `toast.success`/`toast.error` on the staff page, matching
`/dashboard/settings/customers`'s inline-message convention (e.g. `toast.error("Could
not debit wallet.")` surfacing the 422 insufficient-balance message verbatim where the
API provides one). The portal card shows balance/history inline, no toast (matches
`/portal`'s existing plain-`Card` style — no `Toaster` wired in there per the `members`
plan).

Audit linkage: `recordStaffAudit` on every staff mutation
(`chronoWallet.credited/.debited/.adjusted`), each entry capturing the amount and
resulting balance in its `metadata`, not just the action name — a financial audit trail
is only useful if the amount is in it.

### Out of Scope (this plan)

- **The lot-based time-credit entitlement system** (`CreditProducts`/`CreditGrants`/
  etc.) — see "Critical scope finding" above. A separate, later, `stations`-dependent
  plan, not a phase of this one.
- **Loyalty points** — separate, already-deferred system (see above).
- **Online/self-service top-up via a payment gateway** — explicitly out of scope per
  this task's brief; belongs to the deferred `payments`/`pos` modules. `creditWallet()`
  is written generically enough that a future payment-gateway webhook handler can call
  it directly once that module exists, but no gateway integration is built here.
- **Session-time debits** — `sessions` doesn't exist yet; this plan only ships the
  `debitWallet()` helper `sessions` will call. No session-shaped `referenceType`
  enforcement exists until that module lands.
- **Idempotency-key column on `ChronoWalletTransactions`** — oikos itself has this gap
  (see "What exists today" above) and Chrono has no retried-external-request problem yet
  (no payment gateway calling in). Revisit once a real external caller (a payment
  webhook) needs idempotent retries — don't build it speculatively now.
- **Wallet freeze/close (`status`)** — dead, unenforced schema in oikos itself; not
  ported (see schema section above).
- **The `/rpc-admin` platform-admin cross-tenant view** — no
  `PLATFORM_PERMISSION_STATEMENTS` resource exists for this today, same reasoning as
  `branches`/`members`.
- A `chronoWallet.credited`/etc. webhook event — trivial follow-up, not required to ship
  this module.
- `stations`/`shifts`/`devices`/`sessions` code — separate, dependent plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/wallet/schema.ts` (new) — `chronoWallet` +
  `chronoWalletTransaction` tables (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export both, add `"ChronoWallets"`
  and `"ChronoWalletTransactions"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/wallet/` and write `schema.ts` exactly as
   specified in Pass 2 (both tables, all indexes, FK to `base.tenantMember.id`, FK from
   `chronoWalletTransaction.walletId` to `chronoWallet.id`).
2. In `apps/chrono-api/src/db/schema.ts`, add the import/re-export and append
   `"ChronoWallets"`, `"ChronoWalletTransactions"` to `APP_TENANT_TABLES` (check the
   file's current state first — don't clobber a concurrently-landed `branches`/`members`
   entry).
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_wallets` (never
   `db:push`). Review the generated SQL: expect `CREATE TABLE "ChronoWallets"` and
   `CREATE TABLE "ChronoWalletTransactions"` plus their indexes and FKs, no destructive
   statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- Both tables exist with `FORCE ROW LEVEL SECURITY` on.
- Both names are present in `APP_TENANT_TABLES`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/wallet/schema.ts`.

---

## Phase 2 — Contracts + money helper

**Files to update**

- `apps/chrono-api/src/modules/wallet/contracts.ts` (new) — Zod schemas (Pass 2).
- `apps/chrono-api/src/modules/wallet/money.ts` (new) — BigInt-cents decimal-safe
  helpers (Pass 2's "Money math" note).

**Step-by-step tasks**

1. Write `walletTransactionTypeSchema`, `creditWalletSchema`, `debitWalletSchema`,
   `adjustWalletSchema` and their `z.infer` types exactly as specified in Pass 2.
2. Write `money.ts`: `toCents(amount: string): bigint`, `fromCents(cents: bigint):
   string`, `addMoney(a: string, b: string): string`, `negateMoney(a: string): string`,
   `isNegativeMoney(a: string): boolean` — all string-in/string-out, BigInt internally,
   never `Number()`/float arithmetic on a money value. Round-trip-safe for 2-decimal
   amounts (reject/throw on more than 2 decimal places at the boundary — the Zod schema
   already enforces this on input, but `money.ts` itself should not silently truncate).
3. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- `CreditWalletInput`/`DebitWalletInput`/`AdjustWalletInput`/`WalletTransactionType`
  types compile and are importable from `../modules/wallet/contracts`.
- `money.ts` round-trips correctly: `addMoney("10.50", "-3.25") === "7.25"`,
  `isNegativeMoney("-0.01") === true`, `isNegativeMoney("0.00") === false`.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI, the locking service logic (Phase 3).

**Execution start point:** create `apps/chrono-api/src/modules/wallet/money.ts` (the
contracts file has no dependency on it, but writing money math first makes the service
layer in Phase 3 a straightforward composition).

---

## Phase 3 — Service (locking) + routes + permission gates + concurrency proof

**Files to update**

- `apps/chrono-api/src/auth/permissions.ts` — add `wallet: ["read", "credit", "debit",
  "adjust"]` to `CHRONO_PERMISSION_STATEMENTS`, `CHRONO_STAFF_GRANTS`
  (`read`/`credit`/`debit` only), and `CHRONO_ADMIN_GRANTS` (all four), registered via
  `registerAppPermissions()` in `apps/chrono-api/src/auth-bootstrap.ts`. **Never
  `packages/agora`** — see `.ai/rules/business-app.md`, "Permissions: the per-app
  extension seam". (Open Question 1 is resolved in Pass 2.)
- `apps/chrono-api/src/modules/wallet/service.ts` (new) — `lockWalletForUpdate`,
  `applyWalletDelta`, `creditWallet`, `debitWallet`, `adjustWalletBalance` (Pass 2).
- `apps/chrono-api/src/modules/wallet/routes.ts` (new) — `walletRoutes()` factory
  (`TenantVars`).
- `apps/chrono-api/src/modules/wallet/portal-routes.ts` (new) — `walletPortalRoutes()`
  factory (`MemberVars`, `memberMiddleware()`).
- `apps/chrono-api/src/modules/wallet/concurrency.test.ts` (new) — standalone `tsx`
  script proving the row lock, mirroring the existing `test:*` scripts' inline-assertion
  style (`billing-pricing.test.ts`'s `check()` helper pattern).
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/", walletRoutes())` (the factory
  declares its own full `/wallets/...` paths internally).
- `apps/chrono-api/src/app.ts` — `.route("/portal/wallet", walletPortalRoutes())`.
- `apps/chrono-api/package.json` — add `"test:wallet-concurrency": "tsx
  src/modules/wallet/concurrency.test.ts"`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `wallet` gate cases (staff denied
  `adjust`, allowed `credit`/`debit`; admin/owner allowed all).

**Step-by-step tasks**

1. Resolve Open Question 1, then edit `permissions.ts` per Pass 2's exact statement/role
   composition.
2. Write `service.ts`: `lockWalletForUpdate` and `applyWalletDelta` exactly as specified
   in Pass 2 (row lock via `.for("update")`, create-on-miss via `onConflictDoNothing`,
   BigInt-safe money math via `money.ts`, `HttpError(422, ...)` on a would-go-negative
   debit unless `allowNegative`). Export `creditWallet`/`debitWallet`/
   `adjustWalletBalance` — **all three take an already-open `tx: TenantTx`**, never open
   their own transaction (this is what lets `sessions` compose `debitWallet` into its
   own atomic operation later).
3. Write `routes.ts`: every mutating route first looks up
   `SELECT id FROM tenantMember WHERE id = :memberId` **inside the same `withTenant`
   call** that then invokes the service helper — 404 if not found, before any wallet
   read/write (closes the isolation hole from Pass 1/Pass 2). `GET /`, `GET /:memberId`,
   `GET /:memberId/transactions` (`wallet:read`), `POST /:memberId/credit`
   (`wallet:credit`), `POST /:memberId/debit` (`wallet:debit`), `POST /:memberId/adjust`
   (`wallet:adjust`) — each mutation followed by `recordStaffAudit`. Follow the exact
   structure of the `/customers` block in `apps/chrono-api/src/routes/rpc.ts` (import
   style, `HttpError`, pagination meta shape).
4. Write `portal-routes.ts`: `GET /balance` (empty placeholder if no wallet row, no
   auto-create on read), `GET /history` (paginated, empty list if none).
5. Compose into `apps/chrono-api/src/routes/rpc.ts` and `apps/chrono-api/src/app.ts`
   exactly mirroring the `members` plan's `/portal/members` mount.
6. Write `concurrency.test.ts`: seed one tenant + one `tenantMember` (or reuse an
   existing fixture pattern from `test:billing-transactions`), give the member an
   initial wallet balance via a single `creditWallet` call, then fire **N concurrent**
   `debitWallet`/`creditWallet` calls (e.g. `Promise.all` of 10 credits of `"10.00"` and
   10 debits of `"5.00"` against the same `memberId`, run against a **real Postgres**
   connection — `DATABASE_URL_ADMIN`, not `DB_DRIVER=pglite`, since pglite is a single
   in-process instance and cannot exercise genuine concurrent-connection row-lock
   contention) and assert: (a) the final `ChronoWallets.balance` equals the arithmetic
   sum of the starting balance + every delta, with **no lost update**; (b) the count of
   `ChronoWalletTransactions` rows equals exactly the number of calls made (no dropped
   or duplicated ledger rows); (c) replaying the ledger — summing every row's `amount` in
   `createdAt` order — reconstructs the same final balance (the self-checking invariant
   from Pass 2). This is the test that actually proves the "must never lose an update"
   requirement — `typecheck`/`rls:proof` alone cannot catch a race condition.
7. Add `wallet` cases to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { wallet: ["credit"] }) === true`,
   `hasPermission("staff", { wallet: ["debit"] }) === true`,
   `hasPermission("staff", { wallet: ["adjust"] }) === false`,
   `hasPermission("admin", { wallet: ["adjust"] }) === true`,
   `hasPermission("owner", { wallet: ["adjust"] }) === true`.

**Acceptance criteria**

- `POST /rpc/wallets/:memberId/credit` as staff → 201/200 with the updated balance; as
  an unauthenticated/wrong-tenant caller → blocked before the handler runs.
- `POST /rpc/wallets/:memberId/debit` for more than the current balance → 422.
- `POST /rpc/wallets/:memberId/adjust` as staff → 403; as admin/owner → 200, and can
  push the balance negative.
- Any mutating route with another tenant's `memberId` → 404.
- `pnpm --filter @agora/chrono-api test:wallet-concurrency` passes — final balance
  matches the expected sum, transaction-row count matches the call count, ledger replay
  reconstructs the same balance.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `wallet` cases.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`

**Out of scope:** UI, e2e browser spec (Phase 5).

**Execution start point:** edit `apps/chrono-api/src/auth/permissions.ts` first (the
route files reference the new resource, so the vocabulary must exist before either
typechecks).

---

## Phase 4 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/wallets/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `apps/chrono-web/src/app/portal/page.tsx` — extend with a Wallet card.
- `apps/chrono-web/src/lib/wallet-portal.ts` (new) — thin client wrapper for
  `GET /portal/wallet/*`.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected).

**Step-by-step tasks**

1. Build `dashboard/wallets/page.tsx` mirroring
   `apps/chrono-web/src/app/dashboard/settings/customers/page.tsx`: `useListQuery()`,
   `api.rpc.wallets.$get` / `[":memberId"].credit.$post` / `.debit.$post` /
   `.adjust.$post` / `.transactions.$get`, `DataTable`/`DataTableGrid` +
   `DataTableToolbar` + `DataTablePagination`, a type `Badge` (credit/debit/adjustment)
   in the history view, Top Up / Debit dialogs visible to `wallet:credit`/`:debit`
   holders, an Adjust dialog visible only to `wallet:adjust` holders.
2. Add `{ type: "item", name: "Wallets", href: "/wallets", icon: <Wallet> }` to
   `BASE_NAV`, and `"/dashboard/wallets": "Wallets"` to `TITLES`, in
   `apps/chrono-web/src/app/dashboard/layout.tsx`.
3. Write `apps/chrono-web/src/lib/wallet-portal.ts`: `getMyWalletBalance()`,
   `getMyWalletHistory(query)`.
4. Extend `apps/chrono-web/src/app/portal/page.tsx`: add a "Wallet" `Card` next to the
   existing "Your account"/"Membership" cards, showing balance + first-page history.
5. Wire `toast.success`/`toast.error` on the staff page's mutations (surfacing the 422
   insufficient-balance message verbatim), matching `/dashboard/settings/customers`'s
   inline-message convention.

**Acceptance criteria**

- `/dashboard/wallets` renders the list; search/sort/paginate/view-toggle update the
  URL.
- Top Up / Debit / Adjust dialogs submit successfully and the balance + history refresh;
  a staff-role session sees no Adjust action (or gets a toast 403 if it attempts one via
  a stale UI state).
- `/portal` shows the current balance and recent history for the signed-in customer.
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 5), full transaction-history "view all" pagination on
the portal card.

**Execution start point:** create `apps/chrono-web/src/app/dashboard/wallets/page.tsx`.

---

## Phase 5 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/wallet/wallet.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring
   `apps/chrono-web/e2e/tests/data-listing/projects-listing.spec.ts`'s structure and
   `signUp()` helper, covering three cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant (staff) + a customer via `/portal/sign-up`; as
     staff, navigate to `/dashboard/wallets`, top up the customer's wallet, confirm the
     balance updates and a `credit` row appears in history; debit an amount less than
     the balance, confirm success; attempt to debit more than the remaining balance,
     confirm a 422-driven toast and the balance is unchanged; as the customer, reload
     `/portal` and confirm the balance and history match what staff recorded.
   - **Role gate**: owner invites a staff teammate; staff can Top Up/Debit but the
     Adjust action is unavailable (or 403s if forced), while admin/owner can Adjust.
   - **Tenant isolation**: tenant A tops up its customer's wallet; tenant B's
     `/dashboard/wallets` list never shows that member or wallet, and a direct
     cross-tenant `memberId` mutation attempt 404s (drive this via the API client in the
     spec, not just the UI, since the UI itself has no way to construct a foreign id).
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for slugs/emails/names,
   per the rule's explicit requirement.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config, per `.ai/rules/rbac.md`'s "Testing" section).
- No `.env` present in `apps/chrono-api` while running (drives the real dev server).

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/wallet/wallet.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage; a browser-driven concurrency test (that's
what Phase 3's `test:wallet-concurrency` script proves — Playwright is the wrong tool for
proving a DB-level race condition is closed).

**Execution start point:** create `apps/chrono-web/e2e/tests/wallet/wallet.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/wallet/` to
`.ai/plans/chrono/archive/wallet/` once all five phases are verified and committed
separately. Update `.ai/handover/chrono-migration.md`'s status table
(`wallet: done, committed (<hash>)`) and unblock `sessions`' planning — its plan should
reference this one's `debitWallet(tx, { tenantId, memberId, amount, reason,
referenceType: "session", referenceId })` signature directly rather than re-deriving a
wallet-mutation shape.
