# Chrono — `pos` module

**Depends on:** `shifts` (plan done, committed `805dab2`, not yet implemented — a cash sale
requires an open `ChronoShift`, and this plan is what finally populates
`ChronoShifts.expectedCashAmount`/`differenceAmount`, left unpopulated by design in the
`shifts` plan's own Open Question 2). `wallet` (plan done, committed `34c4457`, not yet
implemented — a POS sale may optionally be tendered from a customer's wallet balance,
via the exported `debitWallet(tx, {...})`/`creditWallet(tx, {...})` helpers, same pattern
`credits` already uses). **No hard schema dependency on `members`** — `ChronoSales.memberId`
references the foundation's `tenantMember` table directly (which exists independent of
whether `ChronoMemberProfiles` has landed), the same anchor choice `wallet`'s plan made;
read `members`' plan only for the "is a customer link nullable" convention this plan
follows. **No dependency on `stations`/`devices`/`sessions`/`reservations`** — this plan
does not link a sale to a station or a session (see Out of Scope). `reconciliation`
itself stays deferred (no separate module lands here) — this plan only closes the one
touchpoint `shifts` left open for it.

## What this is

Point-of-sale: a staff member rings up a walk-in or member purchase of physical goods
(snacks, drinks, peripherals, misc items) at the counter, takes payment — cash, card, or
a customer's wallet balance, split across more than one method if needed — and the sale
is recorded against the cashier's open shift so its cash portion feeds shift
reconciliation. This is the module that finally gives Chrono a real retail product
catalog; oikos never built one (see "Critical scope finding" in Pass 2).

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff / Admin / Owner** — rings up sales at **Dashboard → POS**: picks or free-types
  a member (or leaves it a walk-in), adds catalog items or a misc line to the cart, picks
  one or more payment methods, completes the sale, sees a receipt. This is the routine
  counter operation — matches `wallet`'s own staff-inclusive precedent (staff runs the
  till) rather than every prior module's default admin+-only posture.
- **Admin / Owner** — additionally manages the product catalog (**Dashboard → POS →
  Products**: create/edit/disable/restock) and refunds a completed sale — both
  correction/config actions, gated stricter than routine selling, mirroring `wallet`'s
  `credit`/`debit` (staff) vs. `adjust` (admin+) split.
- **Customer (portal)** — not built in this pass. A POS sale is a staff-initiated,
  counter-side transaction; there is no customer-facing POS surface in oikos either. A
  customer can already see wallet debits from a POS wallet-tender in their own wallet
  history (built by the `wallet` plan) — that's the only trace a POS sale leaves in the
  portal.
- **Platform admin (`/rpc-admin`)** — not built in this pass, same as every prior module.

**Workflow:** A customer walks up wanting a soda and to charge a session snack to their
wallet. Staff opens **Dashboard → POS**, searches the member by name/email (or leaves the
sale a walk-in with just a typed name), adds "Soda — ₱35" from the product grid (stock
decrements by 1), enters a payment: ₱35 from the customer's wallet. Staff clicks
**Complete Sale** — the wallet is debited ₱35, the sale is recorded, a receipt appears.
For a walk-in cash sale, staff must have an open shift at the branch first (opening one
if needed is a separate, already-built `shifts` workflow) — the cash portion of every
sale made against that shift accumulates toward what the till should hold at close. An
admin later runs **Refund** on a mis-rung sale: any wallet portion is credited back, any
stock decremented is restored; cash/card portions are recorded as refunded but not
auto-reversed (see "Refund reversal is partial by design" in Pass 2).

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Staff attempting a product-catalog mutation or a refund → 403, gated by
  `requirePermission`.
- Any CASH tender with no open shift for the caller at the sale's branch → **409**
  `"An open shift is required to record a cash payment."` — ported verbatim from oikos's
  `requireOpenShiftForCash` guard.
- A catalog line referencing a `disabled` product → **409** `"This product is not
  available for sale."`
- A stock-tracked product with insufficient `stockQuantity` for the requested quantity →
  **409** `"Insufficient stock for <product name>."` — checked under a row lock, so two
  concurrent checkouts racing the last unit can never both succeed (see "Stock
  concurrency" in Pass 2 — this is the module's own version of `wallet`'s
  "must never lose an update" guarantee, proven the same way, with a dedicated
  concurrency test).
- A wallet tender exceeding the customer's balance → **422** `"Insufficient wallet
  balance"` — bubbles verbatim from `debitWallet`'s own guard (this plan never
  reimplements that check, exactly like `credits` doesn't).
- `sum(payments.amount) < totalAmount` → **400** (Zod-level cross-field check, computed
  after server-side pricing — see Contracts).
- A `productId`/`memberId`/`branchId` that doesn't belong to the caller's tenant → **404**,
  never 403 (no existence leak) — every one is looked up **inside** the same
  `withTenant` transaction before being used, the identical discipline `wallet` mandated
  for `memberId` and `credits` mandated for every foreign id it accepts.
- A double-submitted checkout (network retry, double-click) with the same
  `idempotencyKey` → the second call returns the **same** sale record, not a duplicate —
  the unique `(tenantId, idempotencyKey)` index is the backstop; the route checks first
  and returns the existing row on a hit.
- Refunding an already-refunded sale → **409**.
- **Tenant-isolation leak scenario**: tenant A rings up a sale at its branch; tenant B's
  sale history/product catalog must never show it, and tenant B staff hitting tenant A's
  sale/product id directly on any route gets 404.
- Stale screen: two staff viewing the same product's stock count — last write wins on
  display (the row lock inside the checkout transaction is what makes the count itself
  safe, not client-side staleness detection — matches `wallet`'s own framing).

**Audit / notifications:** every product create/update/restock and every sale
completion/refund writes a `recordStaffAudit` entry (`chronoPos.productCreated` /
`.productUpdated` / `.productRestocked` / `.saleCompleted` / `.saleRefunded`), each
capturing the amount/quantity involved — matching `wallet`'s "an amount must be in the
audit entry, not just the action name" principle. No transactional email/webhook in this
pass, same call as every prior module.

---

## Pass 2 — Technical Planning

### Critical scope finding — oikos's POS has no real product catalog, and this plan does not rebuild wallet top-up or credit-package purchase as cart lines

Research against `C:\Users\ronni\project\izur\oikos`
(`apps/chrono-api/src/modules/pos/**`, `apps/chrono-api/src/database/schema/payments.ts`)
confirms oikos's POS is a thin checkout orchestrator over **three** cart-line types
(`POSItemTypeSchema`: `WALLET_TOPUP | PROMO_PACKAGE | PRODUCT`), not a real retail
system:

- **`WALLET_TOPUP`** calls `walletService.topUp(...)` — adds cash to the customer's
  wallet.
- **`PROMO_PACKAGE`** creates a `CreditPurchases` row + grants — sells a time-credit lot.
- **`PRODUCT`** — the literal retail-item line type — is **rejected server-side if it has
  a nonzero price** (`400 NOT_SUPPORTED`), and its "inventory hook" is a bare
  `console.log` stub with a comment reading `// Phase 5 Inventory Hook: Validate stock &
  deduct quantities`. **No `Product`/SKU/category/stock table exists anywhere in the
  oikos schema.** The frontend's own "Food & Drinks"/"Extras" tabs render "No items
  configured" placeholders. There is no line-item table either — the entire cart
  (`lines`) and full split-tender breakdown (`payments`) are serialized into a single
  generic `Payment.metadataJson` blob; "is this `Payment` row a POS sale" is determined
  by `metadataJson->>'receiptNumber' IS NOT NULL`, not a real discriminator column.

This plan makes two deliberate, load-bearing scope decisions given that finding:

1. **This plan builds the real thing oikos only stubbed**: an actual `ChronoProducts`
   catalog (name, SKU, category, price, optional stock tracking) and proper relational
   `ChronoSaleItems`/`ChronoSalePayments` tables — not a jsonb blob. This is the task's
   own explicit brief ("a product/item catalog — snacks, drinks, peripherals") and a
   direct improvement over prior art that never finished the feature.
2. **This plan does NOT re-implement wallet top-up or credit-package purchase as POS
   cart-line types.** Both already have dedicated, complete purchase surfaces of their
   own: `wallet`'s `POST /rpc/wallets/:memberId/credit` (staff top-up) and `credits`'
   `POST /rpc/credits/purchase` (lot purchase, from the already-committed `credits` plan).
   Duplicating them as POS line types the way oikos's `POSItemTypeSchema` does would
   create two independent ways to perform the same mutation, under two different
   idempotency/audit/permission surfaces — exactly the vocabulary-drift `rbac.md` warns
   against, and a worse design than oikos's own (oikos didn't have `wallet`/`credits` as
   separate first-class modules with their own UIs; Chrono does). **POS in this plan is
   scoped to retail-item sales only.** If the developer wants a single unified "cart" UI
   that can mix a wallet top-up, a credit-package purchase, and retail items in one
   checkout later, that's a `pos`-web-layer composition of three existing API calls, not
   a reason to fork three ledgers into one blob again — flagging as a legitimate later
   UI enhancement, not a gap in this plan.

### Payment methods — cash, card, wallet (a real improvement over oikos, per this task's brief)

oikos's `PaymentMethodEnum` is `CASH | GCASH | MAYA | BANK_TRANSFER` — Philippines-specific
e-wallet rails Chrono-on-Agora has no integration for — and **wallet balance is never a
payment method in oikos's POS at all** (wallet only ever gets topped up there, never
spent from at checkout). This task's brief explicitly asks for the opposite: cash, card,
and **wallet-as-tender**, reusing `debitWallet(tx, {...})` the same way `sessions` and
`credits` already do. This plan implements exactly that — `saleTenderMethodSchema =
z.enum(["cash", "card", "wallet"])` — and drops the PH-specific e-wallet rails as
out-of-scope placeholders (`"card"` is a generic external-card-terminal tender —
recorded with an optional `referenceNumber`, never processed by this system; there is no
payment-gateway integration in this pass, matching every prior module's "online
payment is a deferred `payments`/gateway integration" stance).

Split tender **is** supported (multiple `ChronoSalePayments` rows per sale — see Schema),
matching oikos's real, working split-tender feature, but modeled as proper relational
rows instead of a `metadataJson.payments` array — this is what makes the shift
reconciliation touchpoint (below) a plain SQL sum instead of a jsonb-parsing helper like
oikos's `cashPortionOf()`.

### Walk-ins are genuinely nullable — a real improvement over oikos, confirmed per this task's brief

The task asked to confirm from oikos code whether `memberId` is nullable. Confirmed:
`Payment.userId` is nullable at the schema level, but oikos's own checkout code **never
actually leaves it null** — a `WALKIN` sale synthesizes a throwaway `User` row
(`email: walkin-<uuid>@chrono.local`) and an auto-approved `TenantMember` row via
`applyForTenantMembership(..., skipBranchHistory: true)` for **every single walk-in
sale**, just to have an id to hang the `Payment.userId` FK off. This pollutes the
customer identity pool with junk accounts that will never sign in, never verify an
email, and exist solely to satisfy a NOT-NULL-shaped assumption the schema doesn't
actually enforce.

This plan does the honest thing instead: **`ChronoSales.memberId` is a real nullable
FK.** A walk-in sale has `memberId: null` and an optional free-text `customerName`
snapshot column for the receipt — no identity row is ever created. This is consistent
with `wallet`'s own precedent (`ChronoWallets.memberId` is `.notNull()` because a wallet
mutation always targets a real customer) — POS is the first Chrono module where "no
customer at all" is a first-class, common case (a walk-in buying a soda with cash owes
nothing to any ledger tied to their identity).

### Refund reversal is partial by design, and that's a deliberate, documented improvement over oikos's actual bug

oikos's generic `payments/service.ts` `reverseSideEffects()` — the function every
void/refund goes through — has a real, confirmed bug: on **any** POS `Payment` row, it
unconditionally calls `walletService.debit({..., type: 'REFUND'})` for the **full**
`payment.amount`, gated only on `!payment.sessionId && payment.userId` — a condition
every POS sale satisfies regardless of whether it ever touched the customer's wallet at
all. Refunding a pure cash sale for a bag of chips would still attempt to debit the
customer's wallet by the sale's full amount (and likely throw `'Insufficient Wallet
balance'`, since a cash sale customer's wallet was never credited in the first place).

This plan's refund path is symmetrical and precise instead: it walks the sale's actual
`ChronoSalePayments` rows and reverses **only the wallet-method ones**, by their actual
amount:

- **Wallet-tendered portion** → `creditWallet(tx, { amount: row.amount, reason: "POS
  sale refunded", referenceType: "pos_refund", referenceId: saleId, performedByUserId })`
  for each `method: "wallet"` payment row on the sale.
- **Cash/card-tendered portions** → recorded on the refund's audit entry and left for
  staff to handle physically (hand back cash, process a card-terminal reversal) — this
  system has no drawer-cash integration and no card-gateway integration to reverse
  automatically, so pretending otherwise would be a fabricated success. This mirrors
  `credits`' own "void is unused-only, not pro-rated" philosophy of not inventing
  automation nobody asked for and this system cannot actually perform.
- **Stock** for any `trackStock` product line is restored (row-locked increment),
  regardless of tender method — the physical goods normally come back on a refund, and
  this is safe to automate unconditionally (unlike money, restoring a stock count has no
  external system to reconcile against).

No partial-line refund and no negative-offsetting-sale — a refund is whole-sale, a
status flip (`completed` → `refunded`) plus the reversals above, matching `credits`'
own "void semantics" simplification (Open Question 5 below flags this for confirmation,
same as `credits`' own equivalent open question).

### Stock concurrency (the load-bearing correctness mechanism, proven not just asserted)

Every checkout that touches a `trackStock` product locks that product's row with
`SELECT ... FOR UPDATE` inside the checkout's own `withTenant` transaction before
checking `stockQuantity >= requestedQuantity` and decrementing — the identical
row-lock discipline `wallet`'s `lockWalletForUpdate` and `credits`'
`consumeCredits` both use for their own balance fields, applied here to an inventory
count instead of money/minutes. When a checkout's cart references more than one
stock-tracked product, the products are locked in **ascending `id` order** before any
decrement is applied — the same lock-ordering discipline that prevents two concurrent
multi-item checkouts sharing overlapping products (in different cart order) from
deadlocking each other. Proven in Phase 3 with a dedicated concurrency test (`N`
concurrent single-unit checkouts against a product seeded with exactly `N` units of
stock; assert final `stockQuantity === 0`, exactly `N` sales completed, zero oversold,
zero negative stock) — `typecheck`/`rls:proof` alone cannot catch a stock race, the same
reasoning `wallet`'s Phase 3 gave for its own concurrency script.

### Money math — reused, not reinvented

`apps/chrono-api/src/modules/wallet/money.ts` (`addMoney`/`negateMoney`/
`isNegativeMoney`/`toCents`/`fromCents`) already exists (landed as part of `wallet`'s
Phase 2) and is exactly what this module needs for summing tender amounts and computing
change. This plan **imports it directly** (`import { addMoney } from "../wallet/money"`)
rather than duplicating it — a same-app cross-module import is normal (see `credits`'
own precedent of importing `chronoStationGroup`/`chronoWalletTransaction` schema across
module boundaries within `apps/chrono-api`); `business-app.md`'s "contracts stay
module-local" guidance is about not promoting to `packages/agora` prematurely, not about
forbidding reuse between a business app's own modules.

### Schema — `ChronoProducts`

New file `apps/chrono-api/src/modules/pos/schema.ts`:

```ts
import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoShift } from "../shift/schema";

export const chronoProduct = pgTable(
  "ChronoProducts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Auto-generated from name if omitted, mirrors branch's `code` generator.
    sku: text("sku").notNull(),
    // Free-text, Zod-validated at the contract layer — "snack" | "drink" |
    // "peripheral" | "other" — not a pg enum, matching every prior Chrono
    // plan's convention.
    category: text("category").notNull().default("other"),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    status: text("status").notNull().default("active"), // "active" | "disabled"
    // Stock tracking is opt-in per product (a peripheral you have 3 of; a
    // fountain drink you never count). When false, stockQuantity is
    // meaningless and never checked/decremented.
    trackStock: boolean("trackStock").notNull().default(false),
    stockQuantity: integer("stockQuantity").notNull().default(0),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_product_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_product_tenant_sku_idx").on(t.tenantId, t.sku),
    index("chrono_product_status_idx").on(t.status),
  ],
);
```

Deliberate differences from oikos: there is no oikos `Product` table to diverge from —
this is new. Tenant-wide, not branch-scoped (a snack catalog is normally the same across
a tenant's branches; per-branch stock variance is exactly the kind of real inventory
system — receiving, transfers, suppliers — this plan deliberately does not build, see
Out of Scope). `stockQuantity` has no lower-bound enforcement beyond the checkout guard
(no backorder/negative-stock concept).

### Schema — `ChronoSales`

Same file:

```ts
export const chronoSale = pgTable(
  "ChronoSales",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // Set only when at least one CASH tender is present on the sale — null
    // for an all-card/all-wallet sale, exactly mirroring oikos's own
    // Payment.shiftId semantics (see "Shift linkage" below).
    shiftId: text("shiftId").references(() => chronoShift.id, { onDelete: "set null" }),
    // Nullable — a walk-in sale. See "Walk-ins are genuinely nullable" above.
    memberId: text("memberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // Freeform label for a walk-in's receipt when memberId is null. Ignored
    // when memberId is set (the member's own name is used instead).
    customerName: text("customerName"),
    // Who rang the sale up. restrict, not cascade/set null: a sale's history
    // must survive even if the staff account is later deleted — identical
    // reasoning to ChronoShifts.staffUserId.
    cashierUserId: text("cashierUserId")
      .notNull()
      .references(() => base.user.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("completed"), // "completed" | "refunded"
    totalAmount: numeric("totalAmount", { precision: 12, scale: 2 }).notNull(),
    amountTendered: numeric("amountTendered", { precision: 12, scale: 2 }).notNull(),
    changeAmount: numeric("changeAmount", { precision: 12, scale: 2 }).notNull(),
    // Client-generated, required — the double-submit guard (see Contracts).
    idempotencyKey: text("idempotencyKey").notNull(),
    refundedAt: timestamp("refundedAt"),
    refundedByUserId: text("refundedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    refundReason: text("refundReason"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_sale_tenant_idx").on(t.tenantId),
    index("chrono_sale_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_sale_shift_idx").on(t.shiftId),
    index("chrono_sale_member_idx").on(t.memberId),
    index("chrono_sale_status_idx").on(t.status),
    index("chrono_sale_created_idx").on(t.createdAt),
    uniqueIndex("chrono_sale_tenant_idempotency_idx").on(t.tenantId, t.idempotencyKey),
  ],
);
```

`branchId` is **always required**, even for a non-cash sale — a deliberate simplification
over oikos's "only required if a CASH tender is present" conditional: every sale is
attributable to a branch for reporting, and a staff session already has a branch
context in mind before they start ringing anything up. **Open Question 3** flags this
for confirmation (one-line reversal: make `branchId` nullable and only enforce it in the
cash-tender code path, matching oikos exactly).

**Receipt numbering**: no separate `receiptNumber` column exists. oikos's own
`REC-${Date.now().toString().slice(-6)}` is not collision-safe (confirmed: only the last
6 digits of epoch milliseconds, no tenant/global uniqueness guarantee). Since
`chronoSale.id` (via `createId()`) is already a globally unique, unguessable id, this
plan derives a display receipt number from it at read time —
`` `REC-${sale.id.slice(-8).toUpperCase()}` `` — computed in the route/serializer layer,
never stored, so there is no separate uniqueness mechanism to build or that can drift
from the row's real identity.

### Schema — `ChronoSaleItems`

Same file:

```ts
export const chronoSaleItem = pgTable(
  "ChronoSaleItems",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    saleId: text("saleId")
      .notNull()
      .references(() => chronoSale.id, { onDelete: "cascade" }),
    // Null for an ad-hoc misc line (no catalog entry). restrict when set: a
    // sale's line-item history must always show what it sold — mirrors
    // credits' own ChronoCreditPurchases.productId restrict reasoning.
    productId: text("productId").references(() => chronoProduct.id, { onDelete: "restrict" }),
    // Snapshots — immutable even if the product is later renamed/repriced,
    // same principle as every other module's "snapshot at time of action"
    // columns (credits' grant fields, wallet's balanceBefore/After).
    name: text("name").notNull(),
    sku: text("sku"),
    unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull(),
    lineTotal: numeric("lineTotal", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_sale_item_tenant_idx").on(t.tenantId),
    index("chrono_sale_item_sale_idx").on(t.saleId),
    index("chrono_sale_item_product_idx").on(t.productId),
  ],
);
```

This is the direct, real replacement for oikos's `Payment.metadataJson.lines` array — a
proper relational table instead of unqueryable jsonb, so "what sold, how much, of what"
is a plain SQL aggregate (used both for the product-sales views this plan's UI wants and
for any future reporting module).

### Schema — `ChronoSalePayments`

Same file:

```ts
export const chronoSalePayment = pgTable(
  "ChronoSalePayments",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    saleId: text("saleId")
      .notNull()
      .references(() => chronoSale.id, { onDelete: "cascade" }),
    method: text("method").notNull(), // "cash" | "card" | "wallet"
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    // Card-terminal reference, if the cashier records one. Never processed
    // by this system — no payment-gateway integration in this pass.
    referenceNumber: text("referenceNumber"),
    // Set only for method: "wallet" — the ledger row debitWallet() produced,
    // so a refund can be traced back to the exact wallet mutation it
    // reverses. set null, not restrict: the sale-payment record survives
    // even if the wallet transaction row it points at is ever
    // hard-deleted by some future maintenance path (none exists today).
    walletTransactionId: text("walletTransactionId"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_sale_payment_tenant_idx").on(t.tenantId),
    index("chrono_sale_payment_sale_idx").on(t.saleId),
    index("chrono_sale_payment_method_idx").on(t.method),
  ],
);
```

This is the direct, real replacement for oikos's `Payment.metadataJson.payments` array —
this is what turns the shift-reconciliation sum (below) into a plain
`WHERE method = 'cash'` filter instead of oikos's `cashPortionOf()` jsonb-parsing helper.
`walletTransactionId` is declared `text` with no `.references()` at the Drizzle level
(a real FK to `chronoWalletTransaction.id`, added only once `wallet`'s own table exists
on disk — see "Cross-module FK sequencing" below) but is always a real
`ChronoWalletTransactions.id` value when `method = "wallet"`.

**Cross-module FK sequencing note**: as of this writing, neither `chronoShift` nor
`chronoWallet`/`chronoWalletTransaction` exist on disk yet (`shifts` and `wallet` are
committed *plans*, not landed code — `apps/chrono-api/src/modules/` today only has
`branch/`, `member/`, `device/` contracts, `wallet/` contracts + `money.ts`,
`station/` contracts + schema, `shift/` contracts + schema). This plan's `schema.ts`
**imports `chronoShift`** from `../shift/schema` for a real FK — that file already
exists (`shift`'s Phase 1 schema has landed, per the current repo state), so this is
safe. It does **not** import `chronoWalletTransaction` for `walletTransactionId` (that
file does not exist yet) — if `wallet`'s Phase 1 schema has landed by the time this
plan's Phase 1 executes, upgrade `walletTransactionId` to a real
`.references(() => chronoWalletTransaction.id, { onDelete: "set null" })` import from
`../wallet/schema` instead of the bare `text` column above; if not, ship it as a bare
column now and add the FK in a small follow-up migration once `wallet`'s schema lands —
either way, verify `apps/chrono-api/src/modules/wallet/schema.ts` exists before starting
Phase 1 and adjust this one line accordingly.

### `APP_TENANT_TABLES`

Add `"ChronoProducts"`, `"ChronoSales"`, `"ChronoSaleItems"`, `"ChronoSalePayments"` to
the array in `apps/chrono-api/src/db/schema.ts` (check the file's current state first —
as of this writing it has `"ChronoBranches"`, `"ChronoMemberProfiles"`; `shifts`/`wallet`
haven't landed their own entries yet either, so don't assume `"ChronoShifts"` is already
there — add it too if it's missing and `shift`'s Phase 1 hasn't been applied by the time
this plan executes, coordinating with whoever implements `shifts`), and re-export all
four new tables from the module into that file, mirroring the existing
`chronoBranch`/`chronoMemberProfile` re-export style exactly.

### Contracts — `apps/chrono-api/src/modules/pos/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const productStatusSchema = z.enum(["active", "disabled"]);
export const productCategorySchema = z.enum(["snack", "drink", "peripheral", "other"]);
export const saleStatusSchema = z.enum(["completed", "refunded"]);
export const saleTenderMethodSchema = z.enum(["cash", "card", "wallet"]);

const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

export const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  sku: z.string().min(1).max(50).optional(), // auto-generated from name if omitted
  category: productCategorySchema.optional(), // defaults to "other"
  price: moneyAmountSchema,
  trackStock: z.boolean().optional(),
  stockQuantity: z.number().int().nonnegative().optional(), // only meaningful if trackStock
  status: productStatusSchema.optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const restockProductSchema = z.object({
  quantity: z.number().int().positive().max(100_000),
  reason: z.string().max(255).optional(),
});

export const saleLineInputSchema = z
  .object({
    productId: z.string().min(1).optional(),
    // Required when productId is omitted (an ad-hoc misc line) — ignored
    // and recomputed server-side when productId is present (server-side
    // price authority, see Routes).
    name: z.string().min(1).max(255).optional(),
    unitPrice: moneyAmountSchema.optional(),
    quantity: z.number().int().positive().max(9999).default(1),
  })
  .refine((v) => v.productId || (v.name && v.unitPrice), {
    message: "Either productId, or both name and unitPrice, are required.",
  });

export const saleTenderInputSchema = z.object({
  method: saleTenderMethodSchema,
  amount: moneyAmountSchema,
  referenceNumber: z.string().max(100).optional(),
});

export const checkoutSchema = z.object({
  branchId: z.string().min(1),
  memberId: z.string().min(1).optional(), // walk-in when omitted
  customerName: z.string().max(255).optional(), // walk-in receipt label only
  idempotencyKey: z.string().min(1).max(255),
  items: z.array(saleLineInputSchema).min(1),
  payments: z.array(saleTenderInputSchema).min(1),
});
// Note: sum(payments.amount) >= totalAmount is validated in the route, not
// here — totalAmount is only known once productId lines are server-priced
// (client-supplied prices for catalog items are never trusted).

export const refundSaleSchema = z.object({
  reason: z.string().min(1).max(255),
});

export const listProductsQuerySchema = listQuerySchema(["name", "sku", "price", "createdAt"]).extend({
  status: productStatusSchema.optional(),
  category: productCategorySchema.optional(),
});

export const listSalesQuerySchema = listQuerySchema(["createdAt", "totalAmount"]).extend({
  branchId: z.string().optional(),
  status: saleStatusSchema.optional(),
  shiftId: z.string().optional(),
  memberId: z.string().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type RestockProductInput = z.infer<typeof restockProductSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type RefundSaleInput = z.infer<typeof refundSaleSchema>;
export type ProductStatus = z.infer<typeof productStatusSchema>;
export type SaleStatus = z.infer<typeof saleStatusSchema>;
export type SaleTenderMethod = z.infer<typeof saleTenderMethodSchema>;
```

No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
contracts stay local unless a second business app needs them.

### Service — `apps/chrono-api/src/modules/pos/service.ts`

Every balance-affecting function takes an already-open `tx: TenantTx` and never opens
its own transaction, the same discipline `wallet`/`credits` established:

```ts
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { HttpError } from "agora/server";
import { debitWallet, creditWallet } from "../wallet/service"; // once wallet lands
import { addMoney } from "../wallet/money";
import { chronoProduct, chronoSale, chronoSaleItem, chronoSalePayment } from "./schema";

/**
 * Locks every referenced trackStock product row, in ascending id order (lock-
 * ordering discipline — prevents deadlocks between two concurrent multi-item
 * checkouts sharing products in different cart order), checks availability,
 * and returns the locked rows keyed by id. Throws 404 for a missing/foreign
 * product, 409 for a disabled product or insufficient stock.
 */
async function lockAndValidateProducts(
  tx: TenantTx,
  tenantId: string,
  requests: Array<{ productId: string; quantity: number }>,
): Promise<Map<string, ChronoProductRow>> { /* ... */ }

/**
 * The checkout orchestration: prices every line (server-side authority for
 * catalog lines, trusted client amount for ad-hoc lines), decrements stock,
 * inserts the sale + items + payment rows, and debits any wallet tender.
 * Idempotent on (tenantId, idempotencyKey) — returns the existing sale
 * unchanged on a repeat call instead of erroring.
 */
export async function checkout(
  tx: TenantTx,
  args: { tenantId: string; branchId: string; cashierUserId: string; input: CheckoutInput },
): Promise<{ sale: ChronoSaleRow; items: ChronoSaleItemRow[]; payments: ChronoSalePaymentRow[] }> {
  const existing = await findSaleByIdempotencyKey(tx, args.tenantId, args.input.idempotencyKey);
  if (existing) return existing;

  // memberId ownership check (if provided) — 404 before any wallet/stock
  // touch, closing the isolation hole wallet's Pass 1 mandated for memberId.
  // ...

  const productLines = args.input.items.filter((l) => l.productId);
  const products = await lockAndValidateProducts(tx, args.tenantId, productLines.map(...));

  // Any CASH tender requires an open shift for (tenantId, branchId,
  // cashierUserId) — 409 if none. shiftId captured for the sale row.
  const shiftId = await requireOpenShiftForCash(tx, args); // queries chronoShift directly; null if no CASH tender present

  // Price every line server-side (catalog lines from the locked product row,
  // ad-hoc lines from the trusted client amount), compute totalAmount.
  // Validate sum(payments.amount) >= totalAmount — 400 if not.
  // Insert chronoSale, chronoSaleItem rows, decrement stock on trackStock products.
  // For each payment with method "wallet": debitWallet(tx, { tenantId, memberId, amount, reason: `POS sale`, referenceType: "pos_sale", referenceId: sale.id, performedByUserId: cashierUserId }); store the returned transaction id on the ChronoSalePayments row.
  // Insert chronoSalePayment rows (cash/card rows have walletTransactionId: null).
}

/**
 * Whole-sale refund: reverses only the wallet-tendered payment rows via
 * creditWallet(), restores stock for trackStock lines, flips status. Cash/
 * card portions are recorded, not auto-reversed (see "Refund reversal is
 * partial by design").
 */
export async function refundSale(
  tx: TenantTx,
  args: { tenantId: string; saleId: string; reason: string; performedByUserId: string },
): Promise<ChronoSaleRow> { /* ... */ }

/**
 * The shift-reconciliation touchpoint. Sums the CASH-method
 * ChronoSalePayments rows belonging to `completed` sales on this shift — a
 * refunded sale's cash payment is naturally excluded (its sale.status is no
 * longer "completed"), which is a simplification, not a full reconciliation:
 * it does not account for physical cash a cashier hands back on an
 * in-shift cash refund (there is no drawer-cash ledger to net against — see
 * Open Question 4). Exported for `shift`'s own close route to call.
 */
export async function calculatePosExpectedCash(
  tx: TenantTx,
  args: { tenantId: string; shiftId: string },
): Promise<string> {
  const rows = await tx
    .select({ amount: chronoSalePayment.amount })
    .from(chronoSalePayment)
    .innerJoin(chronoSale, eq(chronoSalePayment.saleId, chronoSale.id))
    .where(
      and(
        eq(chronoSale.tenantId, args.tenantId),
        eq(chronoSale.shiftId, args.shiftId),
        eq(chronoSalePayment.method, "cash"),
        eq(chronoSale.status, "completed"),
      ),
    );
  return rows.reduce((sum, r) => addMoney(sum, r.amount), "0.00");
}
```

### Routes — `apps/chrono-api/src/modules/pos/routes.ts`

A Hono factory `posRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/pos", posRoutes())`:

- `GET /products` — `pos:read`. `listProductsQuerySchema`, `withTenant`, `{ items,
  meta }`.
- `POST /products` — `pos:manageProducts`. `createProductSchema`; auto-generates `sku`
  from `name` when omitted (same `generateBranchCode`-style helper `branches` ported
  from oikos, reused/copied locally); 409 on `(tenantId, sku)` conflict.
  `recordStaffAudit("chronoPos.productCreated", ...)`.
- `PATCH /products/:id` — `pos:manageProducts`. `updateProductSchema` (partial — covers
  price/category/status edits). 404 cross-tenant. `recordStaffAudit("chronoPos.productUpdated", ...)`.
- `POST /products/:id/restock` — `pos:manageProducts`. `restockProductSchema`; 400 if
  `!product.trackStock` (`"This product does not track stock."`); row-locks the product,
  adds `quantity` to `stockQuantity`. `recordStaffAudit("chronoPos.productRestocked", ...)`.
- `GET /sales` — `pos:read`. `listSalesQuerySchema` (filterable by `branchId`/`status`/
  `shiftId`/`memberId`), `withTenant`, joined with `base.tenantMember` (nullable) and
  `base.user` (cashier name) for display, `{ items, meta }`.
- `GET /sales/:id` — `pos:read`. Returns the sale with its `items` and `payments`
  joined. 404 cross-tenant.
- `POST /sales` (checkout) — `pos:sell`. `zValidator("json", checkoutSchema)`. Inside
  `withTenant`, calls `service.checkout(tx, { tenantId, branchId: input.branchId,
  cashierUserId: c.var.tenant.userId, input })`. Errors surface as thrown `HttpError`s
  (404 foreign id, 409 disabled/no-stock/no-open-shift, 400 underpayment, 422
  insufficient wallet balance). `recordStaffAudit("chronoPos.saleCompleted", ...)`
  (skipped on an idempotent replay — no new event for a repeat call). Returns the sale +
  items + payments + a derived `receiptNumber`.
- `POST /sales/:id/refund` — `pos:void`. `refundSaleSchema`. 404 cross-tenant; 409 if
  already `refunded`. Calls `service.refundSale(tx, { tenantId, saleId, reason,
  performedByUserId: c.var.tenant.userId })`. `recordStaffAudit("chronoPos.saleRefunded", ...)`.

No `DELETE` on any resource in this module — products are disabled, not deleted (matches
`branch`'s own precedent); sales are refunded, not deleted (an audit trail, matches
`shift`).

### Permission vocabulary

Adds to `packages/agora/src/auth/permissions.ts` (same precedent as every prior module):

```ts
export const PERMISSION_STATEMENTS = {
  ...
  pos: ["read", "sell", "void", "manageProducts"],
} as const;
```

- `staffRole` — `pos: ["read", "sell"]` (the day-to-day counter operation; matches
  `wallet`'s own precedent of granting staff the routine money-moving action, not the
  cautious admin+-only default every earlier module used).
- `adminRole` — `pos: ["read", "sell", "void", "manageProducts"]` (catalog management and
  refunds are corrections/config, gated stricter than routine selling — same tier split
  `wallet` drew between `credit`/`debit` and `adjust`).
- `ownerRole` — inherits automatically.

**Open Question 1** (resolve before Phase 3): confirm the staff/admin split above. If the
developer wants refunds to require **owner**, not just admin+ (oikos itself gates refund
`requireRole(['OWNER'])` while void is `requireRole(['OWNER','STAFF'])` — a stricter line
than this plan's admin+ default), drop `pos: [...]` from `adminRole` and owner-exclusivity
falls out automatically — a one-line change, same shape as every prior module's
equivalent open question.

### Shift-close reconciliation touchpoint — **this plan populates `ChronoShifts.expectedCashAmount`/`differenceAmount`**

`shifts`' own plan (Phase 3, `POST /:id/close`) explicitly left these two columns `null`
because nothing existed yet to sum cash sales from. **This plan closes that gap.** It
amends the shift-close handler to call `calculatePosExpectedCash` (exported above) before
computing the difference:

```ts
// apps/chrono-api/src/modules/shift/routes.ts — POST /:id/close, inside withTenant,
// after validating the shift and before the update:
import { calculatePosExpectedCash } from "../pos/service";
// ...
const expectedCashAmount = addMoney(
  shift.openingCashAmount,
  await calculatePosExpectedCash(tx, { tenantId, shiftId: shift.id }),
);
const differenceAmount = addMoney(input.actualCashAmount, negateMoney(expectedCashAmount));
// ...update sets expectedCashAmount, differenceAmount alongside status/closedAt/actualCashAmount/closeNotes.
```

This is a **one-directional service import** — `shift/routes.ts` imports from
`pos/service.ts`, never the reverse — which is safe (no schema-level circular FK: `pos`'s
schema already references `chronoShift` for `ChronoSales.shiftId`, and
`calculatePosExpectedCash` only ever takes a `shiftId` as an opaque string parameter, it
never imports anything from `shift/routes.ts`).

**Coordination note**: as of this writing `shift`'s Phase 3 (the close route itself) has
not landed on disk yet — only its Phase 1 schema has. If `shift`'s Phase 3 lands **before**
this plan's shift-reconciliation phase executes, this is a small, reviewable amendment
diff to the existing close handler. If this plan's Phase 4 (below) executes **first** —
i.e., before anyone has implemented `shift`'s own close route — build the close handler
per `shifts`' own Phase 3 spec **with this call folded in from the start**, so the two
plans never produce two competing versions of the same handler; whoever implements
either module first should check `apps/chrono-api/src/modules/shift/routes.ts`'s current
state before writing to it.

### Web UI

- **Staff — `apps/chrono-web/src/app/dashboard/pos/page.tsx` (new)**: the checkout
  screen — member search/walk-in toggle (mirrors `wallet`'s own member-picker pattern),
  a product grid (search/filter by category, from `api.rpc.pos.products.$get`), a cart
  panel (line items, quantity steppers, remove), a payment section supporting one or more
  tenders (`Select` for method, `Input` for amount, running "Total due / Tendered /
  Change" summary — mirrors oikos's own split-tender UX shape described in research, but
  built fresh against this plan's simpler 3-method enum), and a **Complete Sale** button
  (`api.rpc.pos.sales.$post`). On success, a receipt `Dialog` (line items, tenders,
  change, cashier, timestamp, derived receipt number) with a **Print** action (a plain
  browser-print window, matching oikos's own no-dependency approach — no PDF library).
- **Staff — `apps/chrono-web/src/app/dashboard/pos/products/page.tsx` (new)**: the
  catalog management view (`useListQuery()`, `DataTable`/`DataTableGrid`/
  `DataTableToolbar`/`DataTablePagination` from `agora/ui`), a create/edit `Dialog`
  (name, SKU, category `Select`, price, "Track stock" toggle revealing a stock-quantity
  `Input`, status), and a **Restock** action opening a small quantity+reason `Dialog` —
  all visible only to `pos:manageProducts` holders (frontend visibility only, per
  `.ai/rules/rbac.md`).
- **Staff — a "Sale History" tab or sub-page** (`apps/chrono-web/src/app/dashboard/pos/history/page.tsx`,
  or a tab within the main POS page — implementor's call, mirroring `shifts`' own single-
  page list+action pattern): `DataTable` of past sales (receipt number, date, customer,
  cashier, total, status `Badge`), a "View" action reopening the receipt dialog, and a
  **Refund** action (visible only to `pos:void` holders) on `completed` rows.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `POS` entry to `BASE_NAV` (a
  `ShoppingCart`-style `lucide-react` icon) and `"/dashboard/pos": "POS"` to `TITLES`,
  mirroring every prior module's nav entries. A sub-nav or in-page tab handles
  `Products`/`History` rather than separate top-level nav entries (implementor's call —
  matches how `wallet`'s single dashboard page owns its own detail drill-down).
- No module-registry feature-flag gate — POS is core Chrono ops for a tenant that runs a
  retail counter, matching every prior module's reasoning. Confirm with the developer if
  a kill-switch is wanted anyway (some tenants may run no retail counter at all —
  **Open Question 2** flags this specifically, since POS is more plausibly optional per
  tenant than branches/shifts/wallet are).

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List products | `GET /rpc/pos/products` | `pos:read` | paginated, searchable/filterable |
| Create product | `POST /rpc/pos/products` | `pos:manageProducts` | 409 on duplicate `(tenantId, sku)` |
| Update product | `PATCH /rpc/pos/products/:id` | `pos:manageProducts` | 404 cross-tenant |
| Restock product | `POST /rpc/pos/products/:id/restock` | `pos:manageProducts` | 400 if product doesn't track stock |
| List sales | `GET /rpc/pos/sales` | `pos:read` | paginated, filterable by branch/status/shift/member |
| Sale detail | `GET /rpc/pos/sales/:id` | `pos:read` | includes items + payments |
| Checkout | `POST /rpc/pos/sales` | `pos:sell` | 409 no-open-shift (cash) / disabled product / insufficient stock; 422 insufficient wallet balance; 400 underpayment; idempotent on `idempotencyKey` |
| Refund | `POST /rpc/pos/sales/:id/refund` | `pos:void` | whole-sale only; 409 if already refunded; reverses wallet portion + stock only |
| Delete (product) | — | — | not built — disable (`status: "disabled"`) is the only removal, matches `branch` |
| Delete (sale) | — | — | not built — sales are an immutable audit trail, matches `shift` |

Feedback: `toast.success`/`toast.error` at the point of the API call, matching every
prior module's inline-message convention (e.g. surfacing the 422 insufficient-wallet or
409 insufficient-stock message verbatim, same as `wallet`'s 422 handling).

Audit linkage: `recordStaffAudit` on every mutation, each entry capturing the
amount/quantity involved, not just the action name — same principle `wallet` established.

### Out of Scope (this plan)

- **Rebuilding wallet top-up or credit-package purchase as POS cart-line types** — see
  "Critical scope finding" above. Both already have their own dedicated, complete
  purchase surfaces in `wallet`/`credits`.
- **A real multi-branch inventory system** — receiving/purchase orders, supplier
  management, per-branch stock variance, stock-adjustment audit ledger beyond the simple
  restock action, low-stock alerts. `ChronoProducts.stockQuantity` is a single tenant-wide
  counter with a manual restock action — nothing more.
- **Tax and discounts** — confirmed absent from oikos's own DTO/schema/checkout code too;
  not invented here. A line-level or sale-level discount is a real, separately-plannable
  feature if wanted.
- **Partial-line refunds and pro-rated cash/card reversal** — a refund is whole-sale;
  cash/card portions are recorded, not auto-reversed (see "Refund reversal is partial by
  design"). **Open Question 5** flags this for confirmation, mirroring `credits`' own
  equivalent open question about its own void semantics.
- **Station/session linkage** — oikos's POS page has a "start a session on this station"
  post-checkout convenience wired to its `sessions` module. Not built here — this plan
  has no dependency on `stations`/`sessions` per this task's brief. A future amendment
  could add an optional `stationId` reference once that integration is wanted.
- **A card-payment-gateway integration** — the `"card"` tender is recorded with an
  optional reference number only, never processed. Matches every prior module's "online
  payment needs a gateway integration, deferred" stance.
- **Full shift-cash reconciliation** — this plan only populates the two columns
  `shifts` left open (`expectedCashAmount`/`differenceAmount`, cash-sales-only). It does
  not build the separately-deferred `reconciliation` module (variance reporting across
  shifts/branches/date-ranges, discrepancy alerts, etc.) — see
  `.ai/handover/chrono-migration.md`'s deferred list.
- **A customer-facing POS/checkout surface** — POS is staff-only in this pass, matching
  oikos.
- **The `/rpc-admin` platform-admin cross-tenant view** — no
  `PLATFORM_PERMISSION_STATEMENTS` resource exists for this today, same reasoning as
  every prior module.
- A `chronoPos.*` webhook event — trivial follow-up, not required to ship this module.
- Module-registry (`modules.pos`) feature-flag gating of the nav entry (see Open
  Question 2).
- Any `stations`/`devices`/`sessions`/`reservations` code — separate, unrelated plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/pos/schema.ts` (new) — `chronoProduct`, `chronoSale`,
  `chronoSaleItem`, `chronoSalePayment` tables (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export all four, add
  `"ChronoProducts"`, `"ChronoSales"`, `"ChronoSaleItems"`, `"ChronoSalePayments"` to
  `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Verify `apps/chrono-api/src/modules/shift/schema.ts` exists (it does, as of this
   writing) — this module's `chronoSale.shiftId` FK imports `chronoShift` from it.
   Verify whether `apps/chrono-api/src/modules/wallet/schema.ts` exists yet; if not,
   ship `chronoSalePayment.walletTransactionId` as a bare `text` column (no
   `.references()`) per the "Cross-module FK sequencing note" in Pass 2, and leave a
   `// TODO: FK once wallet/schema.ts lands` comment.
2. Create `apps/chrono-api/src/modules/pos/` and write `schema.ts` exactly as specified
   in Pass 2 (four tables, all indexes, the `(tenantId, idempotencyKey)` unique index on
   `ChronoSales`, the `(tenantId, sku)` unique index on `ChronoProducts`).
3. In `apps/chrono-api/src/db/schema.ts`, add the imports/re-exports and append all four
   table names to `APP_TENANT_TABLES` (check the file's current state first — don't
   clobber a concurrently-landed `shift`/`wallet`/`station` entry; add
   `"ChronoShifts"` too if `shift`'s own Phase 1 hasn't been applied to this file yet).
4. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_pos` (never
   `db:push`). Review the generated SQL: expect four `CREATE TABLE` statements plus
   their indexes and FKs (including the FK to `"ChronoShifts"` and, if applicable,
   `"ChronoWalletTransactions"`), no destructive statements.
5. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- All four tables exist with `FORCE ROW LEVEL SECURITY` on.
- All four names are present in `APP_TENANT_TABLES`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, service, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/pos/schema.ts`, after
confirming `shift`'s (and, if present, `wallet`'s) schema files exist to import from.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/pos/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `productStatusSchema`, `productCategorySchema`, `saleStatusSchema`,
   `saleTenderMethodSchema`, `createProductSchema`, `updateProductSchema`,
   `restockProductSchema`, `saleLineInputSchema`, `saleTenderInputSchema`,
   `checkoutSchema`, `refundSaleSchema`, `listProductsQuerySchema`,
   `listSalesQuerySchema`, and their `z.infer` types exactly as specified in Pass 2.
2. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- All listed types compile and are importable from `../modules/pos/contracts`.
- `checkoutSchema` accepts a mixed cart (a `productId` line and an ad-hoc `name`+
  `unitPrice` line in the same request) and a split-tender `payments` array.
- `saleLineInputSchema`'s refine rejects a line with neither `productId` nor
  `name`+`unitPrice`.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** service, routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/pos/contracts.ts`.

---

## Phase 3 — Service (stock locking + checkout + refund) + routes + permission gates + concurrency proof

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `pos: ["read", "sell", "void",
  "manageProducts"]` to `PERMISSION_STATEMENTS`, `staffRole` (`read`/`sell` only), and
  `adminRole` (all four) — resolve Open Question 1 first (Pass 2).
- `apps/chrono-api/src/modules/pos/service.ts` (new) — `lockAndValidateProducts`,
  `checkout`, `refundSale`, `calculatePosExpectedCash`, `requireOpenShiftForCash`,
  `findSaleByIdempotencyKey` (Pass 2).
- `apps/chrono-api/src/modules/pos/routes.ts` (new) — `posRoutes()` factory
  (`TenantVars`).
- `apps/chrono-api/src/modules/pos/concurrency.test.ts` (new) — standalone `tsx` script
  proving stock-decrement race safety, mirroring `wallet`'s
  `concurrency.test.ts`/`test:wallet-concurrency` pattern exactly.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/pos", posRoutes())`.
- `apps/chrono-api/package.json` — add `"test:pos-concurrency": "tsx
  src/modules/pos/concurrency.test.ts"`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `pos` gate cases (staff denied
  `void`/`manageProducts`, allowed `read`/`sell`; admin/owner allowed all).

**Step-by-step tasks**

1. Resolve Open Question 1, then edit `permissions.ts` per Pass 2's exact statement/role
   composition.
2. Write `service.ts`: `lockAndValidateProducts` (ascending-id-order `SELECT ... FOR
   UPDATE`, 404/409 checks), `requireOpenShiftForCash` (a direct `chronoShift` query —
   `status = 'open'`, `branchId`, `staffUserId = cashierUserId`, ordered `openedAt DESC`,
   limit 1 — throws `HttpError(409, ...)` if none, inside the same tx), `checkout`
   (idempotency check first, then server-side pricing, stock decrement, sale/item/payment
   inserts, `debitWallet` for wallet tenders), `refundSale` (wallet-portion reversal via
   `creditWallet`, stock restoration, status flip), `calculatePosExpectedCash` (Pass 2's
   exact SQL). Use `../wallet/money`'s `addMoney`/`negateMoney` throughout — never
   `Number()`/float arithmetic on a money value (`.ai/rules/database.md`).
3. Write `routes.ts`: every route per the "Routes" table in Pass 2, each mutating route
   validating any client-supplied foreign id (`memberId`, `productId`, `branchId`)
   **inside** its `withTenant` call before use, `recordStaffAudit` after each mutation
   (skipped on an idempotent checkout replay). Follow the exact structure of the
   `branch`/`wallet` route blocks (import style, `HttpError`, pagination meta shape).
4. Compose into `apps/chrono-api/src/routes/rpc.ts` via `.route("/pos", posRoutes())`.
5. Write `concurrency.test.ts`: seed one tenant + branch + one `trackStock` product with
   `stockQuantity: N`, fire `N` concurrent single-unit checkouts (`Promise.all`, real
   Postgres via `DATABASE_URL_ADMIN`, not `DB_DRIVER=pglite` — same reasoning `wallet`'s
   own concurrency test gives, pglite cannot exercise genuine concurrent-connection lock
   contention) against the same product, and assert: (a) exactly `N` sales complete
   successfully with zero errors from legitimate attempts; (b) final
   `ChronoProducts.stockQuantity === 0`, never negative; (c) firing one more checkout
   after that (`N+1`th) fails with `409 Insufficient stock`. This is the test that
   actually proves "must never oversell" — `typecheck`/`rls:proof` alone cannot catch a
   stock race.
6. Add `pos` cases to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { pos: ["sell"] }) === true`,
   `hasPermission("staff", { pos: ["void"] }) === false`,
   `hasPermission("staff", { pos: ["manageProducts"] }) === false`,
   `hasPermission("admin", { pos: ["void"] }) === true`,
   `hasPermission("admin", { pos: ["manageProducts"] }) === true`,
   `hasPermission("owner", { pos: ["void", "manageProducts"] }) === true`.

**Acceptance criteria**

- `POST /rpc/pos/sales` as staff → 201 with the sale/items/payments; a repeat call with
  the same `idempotencyKey` → 200 with the identical sale, no duplicate row.
- A CASH tender with no open shift for the caller/branch → 409; a `productId` for a
  `disabled` product → 409; a stock-tracked product oversold beyond `stockQuantity` →
  409; a wallet tender exceeding balance → 422 (bubbled from `debitWallet`).
- `POST /rpc/pos/sales/:id/refund` as staff → 403; as admin/owner on a `completed` sale
  → 200, wallet-tendered portions credited back, stock restored, status `refunded`; on
  an already-`refunded` sale → 409.
- Any mutating route with another tenant's `memberId`/`productId`/`branchId` → 404.
- `pnpm --filter @agora/chrono-api test:pos-concurrency` passes — no oversell, no
  negative stock, exactly `N` successful sales.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `pos` cases.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:pos-concurrency`

**Out of scope:** the shift-close reconciliation wiring (Phase 4), UI (Phase 5), e2e
browser spec (Phase 6).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (the
routes file references the new resource, so the vocabulary must exist before it
typechecks).

---

## Phase 4 — Shift-close reconciliation wiring

**Files to update**

- `apps/chrono-api/src/modules/shift/routes.ts` — amend (or, if not yet built by anyone,
  create per `shifts`' own Phase 3 spec with this folded in) the `POST /:id/close`
  handler to call `calculatePosExpectedCash`.

**Step-by-step tasks**

1. Check whether `apps/chrono-api/src/modules/shift/routes.ts` exists yet.
   - **If it exists** (someone has implemented `shifts`' Phase 3): add the import and
     the `expectedCashAmount`/`differenceAmount` computation exactly as shown in Pass 2's
     "Shift-close reconciliation touchpoint" section, inside the existing `withTenant`
     transaction, before the `update(chronoShift)` call. Do not touch any other part of
     the handler.
   - **If it does not exist**: build it per `shifts`' own committed plan
     (`.ai/plans/chrono/active/shifts/README.md`, Phase 3) verbatim, with this plan's
     `calculatePosExpectedCash` call folded into the close handler from the start (do
     not implement a version without it and amend later).
2. Confirm `shifts`' plan's own acceptance criteria for `POST /:id/close` still hold
   (404 cross-tenant, 409 already-closed, `actualCashAmount`/`closeNotes` set) — this
   phase only adds the two previously-null columns, it does not change any other
   close-route behavior.

**Acceptance criteria**

- Closing a shift with at least one completed cash sale attributed to it (`shiftId`
  matching, `method: "cash"`) produces a non-null `expectedCashAmount` equal to
  `openingCashAmount + sum(those cash sale payments)`, and `differenceAmount =
  actualCashAmount - expectedCashAmount`.
- Closing a shift with zero attributed cash sales produces `expectedCashAmount ===
  openingCashAmount` (not null — the sum of zero rows is `"0.00"`, per `addMoney`'s
  own behavior), matching the arithmetic identity rather than leaving the field blank.
- A refunded cash sale on the shift does not count toward `expectedCashAmount` (its
  `status` is no longer `"completed"`).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** full reconciliation reporting (the deferred `reconciliation` module);
accounting for a same-shift cash refund's physical cash return (Open Question 4).

**Execution start point:** `Read` `apps/chrono-api/src/modules/shift/routes.ts` first to
determine which of the two paths above applies.

---

## Phase 5 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/pos/page.tsx` (new) — checkout screen.
- `apps/chrono-web/src/app/dashboard/pos/products/page.tsx` (new) — catalog management.
- `apps/chrono-web/src/app/dashboard/pos/history/page.tsx` (new, or a tab on the main
  page — implementor's call) — sale history + refund action.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected — `Dialog`/`Select`/`Input`/`Label`/`Badge`/`DataTable` already exist).

**Step-by-step tasks**

1. Build `pos/page.tsx`: member search/walk-in toggle, product grid (search/filter by
   category), cart panel with quantity steppers and a misc-item add affordance,
   multi-tender payment section, **Complete Sale** button
   (`api.rpc.pos.sales.$post`), receipt `Dialog` with **Print**.
2. Build `pos/products/page.tsx` mirroring `apps/chrono-web/src/app/dashboard/branches/page.tsx`:
   `useListQuery()`, `api.rpc.pos.products.$get/$post/$patch`, create/edit `Dialog`,
   **Restock** action `Dialog` — all `agora/ui` primitives only
   (`.ai/rules/component-first-ui.md`).
3. Build the sale-history view: `DataTable` of past sales, a **View** action reopening
   the receipt dialog, a **Refund** action (visible only to `pos:void` holders) with a
   reason `Dialog`.
4. Wire `toast.success`/`toast.error` on every mutation, surfacing 409/422 messages
   verbatim, matching `wallet`'s inline-message convention.
5. Add `{ type: "item", name: "POS", href: "/pos", icon: <ShoppingCart> }` to
   `BASE_NAV`, and `"/dashboard/pos": "POS"` to `TITLES`, in
   `apps/chrono-web/src/app/dashboard/layout.tsx`.

**Acceptance criteria**

- `/dashboard/pos` completes a walk-in cash sale (with an open shift) and a member
  wallet-tendered sale end to end, showing a receipt.
- `/dashboard/pos/products` create/edit/restock all work; search/sort/paginate/
  view-toggle update the URL.
- The sale-history view's Refund action is hidden (or 403-toasts) for a staff session.
- No raw HTML chrome introduced in `apps/chrono-web`.

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 6).

**Execution start point:** create `apps/chrono-web/src/app/dashboard/pos/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/pos/pos.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring `apps/chrono-web/e2e/tests/wallet/wallet.spec.ts`'s
   structure and `signUp()` helper, covering three cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant, create a branch, open a shift, create a product,
     ring up a cash sale for a walk-in (confirms the open-shift guard passes and the
     receipt shows), ring up a wallet-tendered sale for a signed-up member with a
     pre-funded wallet (confirms the wallet debit and the balance drop, cross-checking
     `/dashboard/wallets`), close the shift and confirm `expectedCashAmount`/
     `differenceAmount` reflect the cash sale (drives `/dashboard/shifts`).
   - **Business-rule / role gate**: attempting a cash sale with no open shift surfaces
     the 409 as a toast; staff can sell but the Refund action is unavailable (or 403s if
     forced) while admin/owner can refund, confirming a refunded sale's wallet portion
     is credited back.
   - **Tenant isolation**: tenant A's product catalog and sale history never appear for
     tenant B; a direct cross-tenant `productId`/sale-`memberId` mutation attempt 404s
     (drive via the API client in the spec, matching `wallet.spec.ts`'s own approach for
     ids the UI has no way to construct).
2. Use `@faker-js/faker` for names/emails/slugs (`.ai/rules/e2e-testing.md`) — not
   hand-rolled `Date.now()` strings.

**Acceptance criteria**

- All three cases pass locally against `pnpm dev` (manual/headed suite, no `webServer`
  in the Playwright config, per `.ai/rules/rbac.md`'s "Testing" section).
- No `.env` present in `apps/chrono-api` while running.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/pos/pos.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage; a browser-driven stock-concurrency test
(that's what Phase 3's `test:pos-concurrency` script proves).

**Execution start point:** create `apps/chrono-web/e2e/tests/pos/pos.spec.ts`.

---

## Open Questions (developer to confirm/override — none block Phase 1)

1. **Staff/admin split**: `staff` holds `pos:read`/`pos:sell`; `pos:void`/
   `pos:manageProducts` are admin+. If the developer wants refunds owner-only (matching
   oikos's own stricter `requireRole(['OWNER'])` on its refund route, stricter than its
   own `void` route), drop `pos` from `adminRole` — one-line change.
2. **No module-registry feature flag**: POS assumes every Chrono tenant runs a retail
   counter, unlike prior modules where that assumption is safer (every tenant has
   branches/shifts/wallets). A tenant with no physical counter may want to hide this nav
   entry entirely — flagging since this module is more plausibly optional than its
   predecessors.
3. **`branchId` required on every sale, not just cash ones**: a deliberate simplification
   over oikos's "only required for cash" conditional. One-line reversal if the developer
   wants it optional for non-cash sales.
4. **`expectedCashAmount` does not net out an in-shift cash refund's physical cash
   return** — there is no drawer-cash ledger to reconcile against (that's the deferred
   `reconciliation` module's eventual territory). Flagging as a known first-pass
   simplification, not an oversight.
5. **Refund is whole-sale, cash/card portions are recorded not auto-reversed** — see
   "Refund reversal is partial by design" in Pass 2. Mirrors `credits`' own equivalent
   open question about its void semantics.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/pos/` to `.ai/plans/chrono/archive/pos/`
once all six phases are verified and committed separately. Update
`.ai/handover/chrono-migration.md`'s status table (`pos: done, committed (<hash>)`).
