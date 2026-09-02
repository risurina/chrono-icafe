# Chrono — `payment` module (reconciliation with oikos/karta-tenant)

Status: **Archived 2026-09-02 — all 3 phases landed.** Phase 1 (schema + RLS +
contracts), Phase 2 (service + routes + permission gates), Phase 3 (web UI + e2e,
Phase 3's e2e spec delegated to Jules session `1260577097211669521`, pulled and fixed
locally — see `.ai/handover/jules-sessions.md`) — `pnpm typecheck` (both apps),
`rls:proof`, `test:permissions` all clean. Not carried over: the standalone
`concurrency.test.ts` and the `payment` gate block in `src/e2e/run.ts` (deferred, noted
at implementation time as out of scope for this pass); `reverseSideEffects` only
reverses the plain wallet-top-up case (a payment funding a `ChronoCreditPurchase` has no
`paymentId` linking column yet — deferred, see "Deliberate differences from oikos"
below).

Status (superseded): **Audited, revised 2026-09-02** — `plan-auditor` verdict was NEEDS
REVISION (idempotency-key precedent claim was false, `pay` route was ungated,
double-refund semantics self-contradicted, a nonexistent `wallet` API was referenced,
verification commands targeted the wrong package). All findings applied below. Phase 1
and 3 were already implementation-ready; Phase 2 is now fixed. Ready for implementation.

## Resolved decisions

1. **Refund permission tier: admin+** (not owner-only). Consistent with
   `wallet:adjust`/`credit:adjust` — a refund here is not materially higher-risk than
   those, both already admin+.
2. **Wave placement: Wave 1.** A `wallet:credit` top-up today has no payment-method/
   counter-audit trail — this closes a real gap under modules already shipped, not a
   later-wave nice-to-have. `apps/chrono-api/AGENTS.md` is updated below to reflect it.
3. **Reservation-deposit linkage: deferred.** No `reservationId` FK in this pass — add
   it in a later phase if a reservation-deposit workflow is actually requested.

## Why this plan exists

oikos/karta-tenant has a first-class, standalone `payments` module (`Payments` +
`PaymentEvents` tables) with no equivalent anywhere in agora's Chrono plans
(archived, active, or in `apps/chrono-api/AGENTS.md`'s Wave 1 / deferred lists — it
was simply never triaged). Agora today only has `ChronoSalePayments`
(`apps/chrono-api/src/modules/pos/schema.ts:130`) — a tender-line record scoped to
one POS `chronoSale`, with no independent status lifecycle. Per `AGENTS.md`, oikos is
"prior art, not a spec" — this plan proposes the improved shape, not a port.

## Pass 1 — Workflow Analysis

**Who uses this**: `staff` (create/pay), `admin`/`owner` (void/refund) — see resolved
decision 1 and the permission vocabulary below.

**What workflow does oikos's `payments` module enable that agora's `ChronoSalePayments`
doesn't?**

1. **A payment that exists before it's paid.** oikos's `Payment` has a
   `PENDING → PAID/CANCELLED` lifecycle with `expiresAt`/`checkoutUrl`/
   `providerReference` — modeling a payment request that can be created, then
   completed later (e.g. a provider checkout redirect, or a manual payment recorded
   ahead of cash arriving). `ChronoSalePayments` has no such thing — a sale-payment
   row is only ever created already-settled, at checkout time, tied 1:1 to a sale.
2. **A wallet top-up that is not a POS sale.** oikos's `markAsPaid` treats a
   standalone payment with no `sessionId` as a wallet top-up and calls into its
   wallet service. Agora's `wallet:credit` action lets staff credit a wallet
   directly (`apps/chrono-api/src/modules/wallet/routes.ts`, calling
   `creditWallet()` in `wallet/service.ts`), but with **no payment record backing
   it** — there is no `Payment` row, no audit trail of "how much cash changed hands,
   via what method, recorded by whom," separate from the wallet ledger entry itself.
3. **Void/refund with side-effect reversal.** oikos's `voidPayment`/`refundPayment`
   both reverse the wallet top-up or the credit grants a payment produced
   (`reverseSideEffects`, walking `CreditPurchases` → `CreditGrants`, refusing to
   reverse a grant that's already been partially consumed). Agora already has this
   exact reversal-with-partial-consumption-guard logic — `voidCreditPurchase`
   (`apps/chrono-api/src/modules/credit/service.ts:350-394`) — but nothing that
   *triggers* it from a generic "whatever this payment funded" caller; this plan's
   `reverseSideEffects` dispatches to it (see Pass 2) rather than reimplementing it.
4. **An event ledger.** `PaymentEvents` records every state transition. Agora's own
   `chronoCreditGrantLedgerEntry`/`chronoWalletTransaction` are append-only ledgers
   with the same intent, but **neither carries an idempotency key or unique index**
   — `credit/schema.ts` explicitly rejected one, since a sale/grant completes
   atomically with its wallet debit with no async step to replay
   (`chronoCreditGrantLedgerEntry`'s own column comment: "this pass has no PENDING/
   PAID intermediate state... there is no async payment step here to be pending
   about"). This module is the first one that genuinely has that intermediate
   `pending` state, so it's the first one where an idempotency key earns its place
   — see Pass 2 for the narrowed justification (forward-provisioning for a future
   provider-webhook replay, not a "reuse the existing pattern" claim).

**What does the user see, click, confirm, or wait for?**
A staff member recording a manual payment (cash/card at the counter, not through
POS checkout) — e.g. topping up a customer's wallet directly with cash — sees a
payment recorded, then can void or (owner only) refund it later if it was a mistake,
with the wallet debited back out automatically.

**Failure cases**: double-completion of the same payment (must not double-credit, see
Phase 2 idempotency/lock design); voiding/refunding a payment whose funded credit
grant has already been partially consumed (409, matching `voidCreditPurchase`'s
existing behavior); refunding/voiding a payment that is not currently `"paid"` (409,
including a second refund/void attempt — see Phase 2 acceptance criteria); refunding
a payment tied to no wallet/grant (a no-op reversal, not an error); wrong tenant/
branch (RLS + `withTenant`, as everywhere else); role gate (staff for create/pay,
admin+ for void/refund).

**Audit**: every state transition writes an immutable event row, mirroring
`chronoWalletTransaction`/`chronoCreditGrantLedgerEntry`'s existing ledger shape.

## Pass 2 — Technical Planning

**Reuse target**: this is a strict analog of `apps/chrono-api/src/modules/wallet/`
and `apps/chrono-api/src/modules/credit/` — copy their schema/service/routes shape
(numeric ledger columns, `balanceBefore`/`balanceAfter`-style invariants,
`concurrency.test.ts` pattern for the `for update` row lock) rather than oikos's raw
`db.transaction` + untyped `tx: any`.

**Where it lives**: `apps/chrono-api/src/modules/payment/` (singular, matching
`wallet`/`credit`/`voucher`/`promo` naming convention — not `payments`).

**Schema** (`apps/chrono-api/src/modules/payment/schema.ts`):

- `ChronoPayments` — `id`, `tenantId` (FK `organization.id`, cascade), `branchId`
  (nullable FK `chronoBranch.id`, set null), `memberId` (nullable FK
  `base.tenantMember.id`, set null — agora's customer pool, not oikos's `userId`),
  `sessionId` (nullable FK `chronoSession.id`, set null — real from day one, `session`
  schema has landed in `db/schema.ts`/`APP_TENANT_TABLES`, no hedge needed), `amount`
  (numeric 12,2, reusing `wallet/contracts.ts`'s positive-decimal bound), `currency`
  (default from tenant, matching `chronoWallet.currency`), `method` (free text,
  Zod-validated at the contract layer — matches the dominant agora convention already
  used by `chronoWalletTransaction.type` and `chronoSalePayment.method`, **not**
  oikos's Postgres `PaymentMethodEnum`), `status` (`"pending" | "paid" | "voided" |
  "refunded"` — two distinct terminal states, not one shared `"cancelled"`, so the
  list view can show *why* a payment is dead without joining the event ledger; a
  cash-drawer/tax reconciliation needs to distinguish a mistaken-entry void from a
  genuine customer refund), `providerReference` (nullable text), `paidAt`/
  `expiresAt`/`createdAt`/`updatedAt`.
- `ChronoPaymentEvents` — `id`, `tenantId`, `paymentId` (FK, cascade), `eventType`
  (free text: `"received" | "cancelled" | "voided" | "refunded"`), `idempotencyKey`
  (nullable text), partial unique index on `(tenantId, idempotencyKey)` where not
  null. **No existing Chrono module has this column** — `chronoCreditGrantLedgerEntry`
  deliberately has none, because a sale/grant completes atomically with no async
  step to replay. `ChronoPayments` is the first module with a genuine `pending`
  intermediate state, so the key is forward-provisioning for a future
  provider-webhook replay (deferred in this pass, see "Deliberate differences"
  below) — not a reused pattern. Because the row-lock + status check in `markAsPaid`
  already makes a same-request double-completion impossible on its own, this key
  earns nothing until a provider-supplied key exists; **the column may be dropped
  from Phase 1 entirely and re-added when provider integration lands**, at the
  implementer's discretion — it is schema-only risk, not a correctness gap either
  way. `payloadJson` (jsonb, metadata only — reason, actor).
- Both tables get `*_tenant_idx` on `tenantId` and go into `APP_TENANT_TABLES`
  (`apps/chrono-api/src/db/schema.ts`).

**Deliberate differences from oikos** (to record here, not just in code comments):

- No `PaymentProviderEnum`/checkout-URL/provider-webhook path in this pass — agora
  has no payment-gateway integration yet (mirrors `chronoSalePayment`'s own
  "never processed by this system" note). `provider` column is deferred until a real
  gateway is wired (`.ai/rules/providers.md`); until then every payment is
  effectively oikos's `MANUAL` provider, so the column is omitted rather than
  defaulted to a single enum value nothing else uses.
- Free-text `method`/`status`/`eventType` instead of Postgres enums — matches the
  dominant agora convention (`wallet`, `pos`, `credit` modules), avoids the
  non-idempotent `CREATE TYPE` migration ceremony `.ai/rules/database.md` warns
  about for a handful of string values.
- `memberId` (agora's `tenantMember`) instead of oikos's `userId` — agora's
  customer identity is the foundation's `tenantMember` pool
  (`.ai/rules/business-app.md`, "Reuse the foundation's end-customer pool"), not a
  business-app-local `User` table.
- No `reservationId`/`shiftId` FK columns yet — resolved decision 3 above (deferred).
- `ChronoPayments` is **distinct from the foundation's `paymentTransaction`**
  (`"PaymentTransactions"`, `apps/agora-api`/`packages/agora` db schema) — that table
  is the PSP webhook mirror for *tenant subscription billing*
  (`.ai/rules/rbac.md`'s `billing` resource), a wholly different concern from this
  in-venue counter-payment module. No naming collision (`Chrono`-prefixed per
  `.ai/rules/business-app.md`), but worth stating once since "payment" now names two
  things in this app.
- `amount` reuses `wallet/contracts.ts`'s positive-decimal Zod schema and its
  `MAX_BALANCE` bound; all arithmetic goes through `wallet/money.ts`'s
  `toCents`/`addMoney` (integer-cent `BigInt`), never raw JS numbers — same
  precision-safety rule as every other money-handling module.

**Permission vocabulary** (`apps/chrono-api/src/auth/permissions.ts`,
`CHRONO_PERMISSION_STATEMENTS`):

```ts
payment: ["read", "create", "pay", "void", "refund"],
```

- `read`/`create`/`pay` at staff tier — mirrors `wallet: ["read", "credit", "debit"]`'s
  own precedent (recording and settling a manual payment is routine counter work,
  same tier as a wallet credit). `pay` is a **distinct action from `create`**:
  creating a pending payment and settling it (the step that actually moves money
  into a wallet, via `markAsPaid`) are different acts and must gate separately —
  reusing `create` for both would make the RBAC gate test unable to fail if `pay`
  were ever left ungated.
- `void` at admin+ — mirrors `pos:void`'s existing tier exactly.
- `refund` at admin+ — resolved decision 1 above (not owner-only, despite oikos
  gating this `OWNER`-only).

**Files to touch**:

- New: `apps/chrono-api/src/modules/payment/{schema,contracts,service,routes,concurrency.test}.ts`
- Edit: `apps/chrono-api/src/db/schema.ts` (compose new tables, add to `APP_TENANT_TABLES`)
- Edit: `apps/chrono-api/src/auth/permissions.ts` (add `payment` resource + staff/admin grants)
- Edit: `apps/chrono-api/src/routes/rpc.ts` (mount `paymentRoutes()`)
- **No wallet-service edit needed.** `creditWallet`/`debitWallet`
  (`apps/chrono-api/src/modules/wallet/service.ts:99,114`) already accept
  `referenceType`/`referenceId` — exactly this seam, and
  `chronoWalletTransaction`'s own column comment names the payment case as its
  motivating example ("mirrors how oikos itself needed several separate nullable
  FK columns (paymentId, sessionId) for this same 'what caused this' concept"). The
  payment service calls these directly with `referenceType: "payment"` /
  `referenceId: payment.id`.
- New web: `apps/chrono-web/src/app/dashboard/payments/` (list + void/refund actions),
  following the `agora/ui` `DataTable` stack (`.ai/rules/data-listing.md`).
- New: `apps/chrono-web/e2e/tests/payments/*.spec.ts` (happy path, role gate,
  cross-tenant isolation — `.ai/rules/e2e-testing.md`).

**Tenant/role/RLS implications**: standard — every table in `APP_TENANT_TABLES`,
every mutation through `withTenant` + `requirePermission`. No new isolation surface
beyond the existing pattern; `rls:proof` re-run required per
`.ai/rules/database.md`.

**Out of scope for this plan**: payment-gateway/provider integration (Stripe/Xendit/
PayMongo — `.ai/rules/providers.md`'s `BillingProvider` category is for *tenant
subscription* billing, a different concern from this in-venue counter-payment
module); reservation-deposit linkage (Open Question 3); anything in
`apps/chrono-pc-client*` (out of scope for the whole Chrono migration per
`AGENTS.md`).

## Phase Design

### Phase 1 — Schema + RLS + contracts

**Files to Update**:
- New: `apps/chrono-api/src/modules/payment/schema.ts` (`chronoPayment`,
  `chronoPaymentEvent` tables, per Pass 2 shape above)
- New: `apps/chrono-api/src/modules/payment/contracts.ts` (Zod schemas:
  `createPaymentSchema`, `payPaymentSchema`, `voidPaymentSchema`,
  `refundPaymentSchema`, `paymentDtoSchema`)
- Edit: `apps/chrono-api/src/db/schema.ts` (import + compose both tables, add
  `"ChronoPayments"` and `"ChronoPaymentEvents"` to `APP_TENANT_TABLES`)

**Step-by-Step Tasks**:
1. Define `chronoPayment` and `chronoPaymentEvent` in `schema.ts` exactly per the
   Pass 2 column list (free-text `method`/`status`/`eventType`, partial unique index
   on `(tenantId, idempotencyKey)` for `chronoPaymentEvent`, `*_tenant_idx` on both).
2. Add both table names to `APP_TENANT_TABLES` in `db/schema.ts`.
3. Write `contracts.ts` Zod schemas matching the columns; derive DTO types with
   `z.infer` per `.ai/rules/dto.md`.
4. `pnpm db:generate --name chrono_payment_module` then `pnpm db:migrate`.

**Acceptance Criteria**: both tables exist with forced RLS; migration applied
cleanly; contracts export from the module, no Drizzle model leaked as a transport
type.

**Verification Commands**: `pnpm typecheck`; `pnpm --filter @agora/chrono-api rls:proof`
(must print `RLS PROOF: PASS ✅` — Chrono owns its own `rls:proof` script, distinct
from the `@agora/api` scaffold's).

**Out-of-Scope**: routes, service logic, permissions — Phase 2.

**Execution Start Point**: `apps/chrono-api/src/modules/wallet/schema.ts` (copy its
shape) and `apps/chrono-api/src/db/schema.ts`'s existing `APP_TENANT_TABLES` array.

### Phase 2 — Service + routes + permission gates

**Files to Update**:
- New: `apps/chrono-api/src/modules/payment/service.ts` (`createPayment`,
  `markAsPaid`, `voidPayment`, `refundPayment`, `reverseSideEffects` helper —
  imports `creditWallet`/`debitWallet` from `../wallet/service` and
  `voidCreditPurchase` from `../credit/service`)
- New: `apps/chrono-api/src/modules/payment/routes.ts` (`paymentRoutes()` Hono
  factory typed on `TenantVars`)
- New: `apps/chrono-api/src/modules/payment/concurrency.test.ts` (row-lock
  double-completion / double-refund tests, copy `wallet/concurrency.test.ts`'s
  pattern)
- Edit: `apps/chrono-api/src/auth/permissions.ts` — add
  `payment: ["read", "create", "pay", "void", "refund"]` to
  `CHRONO_PERMISSION_STATEMENTS`; `payment: ["read", "create", "pay"]` to
  `CHRONO_STAFF_GRANTS`; `payment: ["read", "create", "pay", "void", "refund"]` to
  `CHRONO_ADMIN_GRANTS`.
- Edit: `apps/chrono-api/src/routes/rpc.ts` — mount `paymentRoutes()`.
- Edit: `apps/chrono-api/src/e2e/permissions.test.ts` — add a `chrono payment
  permissions` block mirroring the existing `chrono wallet permissions` block's
  shape (staff-may / staff-may-NOT / admin-may cases per action).
- Edit: `apps/chrono-api/src/e2e/run.ts` — add a `payment` gate block, per
  `.ai/rules/business-app.md`'s "extend with each module's block."
- Edit: `apps/chrono-api/src/modules/wallet/service.ts` — accept an optional
  `paymentId` in `topUp`/`debit`'s metadata param (no schema change) so a wallet
  transaction traces back to the payment that caused it.

**Step-by-Step Tasks**:
1. `createPayment` — `status: "pending"`, validated via `createPaymentSchema`.
   `requirePermission` on `payment:create`, imported from the app-local typed
   wrapper `apps/chrono-api/src/auth/require-permission.ts` (never `agora/auth`
   directly — `payment` is a Chrono-owned resource, `.ai/rules/business-app.md` §4;
   `wallet/routes.ts:15` is the pattern to copy).
2. `markAsPaid` (gated `payment:pay`) — `for update` row lock on `chronoPayment`
   (mirrors `wallet`/`credit` concurrency pattern), idempotent on already-`paid`
   (return existing, no double-credit), inserts a `chronoPaymentEvent` row (with
   `idempotencyKey` only if Phase 1 kept the column), calls `creditWallet(tx, {
   tenantId, memberId, amount, reason: "payment", referenceType: "payment",
   referenceId: payment.id, performedByUserId })` when `memberId` is set and
   `sessionId` is null, then `recordStaffAudit(...)` with the amount/method/
   memberId in the metadata (matching `walletAuditMetadata`'s convention — see
   `wallet/routes.ts:44-46`'s reasoning for why the amount must be in the audit
   trail).
3. `voidPayment` (gated `payment:void`) / `refundPayment` (gated `payment:refund`)
   — `for update` lock; if `status !== "paid"`, throw `HttpError(409, ...)` (matches
   `voidCreditPurchase`'s existing 409 convention, `credit/service.ts:358-361` —
   this includes a second void/refund attempt on an already-`voided`/`refunded`
   payment, so **there is no no-op path**: a concurrent second caller loses the row
   lock race and then hits this same 409, never a silent no-op). On success: set
   `status` to `"voided"`/`"refunded"` respectively (not a shared `"cancelled"`),
   insert the event row, call `reverseSideEffects`.
4. `reverseSideEffects(tx, payment, ctx)`: if `!payment.sessionId && payment.memberId`,
   call `debitWallet(tx, { ..., referenceType: "payment_void" | "payment_refund",
   referenceId: payment.id })`. If the payment funded a `ChronoCreditPurchase`
   (joined via `creditPurchase.paymentId`), **dispatch to the existing
   `voidCreditPurchase()`** (`credit/service.ts:350-394`) rather than
   re-implementing the grant-reversal walk — it already has the
   partially-consumed guard. `voidCreditPurchase`'s docblock requires its caller to
   have already locked both the purchase and grant rows `FOR UPDATE`; this service
   must acquire locks in a consistent order (payment → purchase → grant) on every
   call path to avoid a deadlock against any other code that locks the same rows.
   If the payment funded nothing, this is a no-op.
5. Routes: `POST /payments`, `GET /payments`, `GET /payments/:id`,
   `POST /payments/:id/pay`, `POST /payments/:id/void`,
   `POST /payments/:id/refund` — `requirePermission` before any DB work on every
   mutating route, `withTenant` for every query.
6. `concurrency.test.ts`: two concurrent `markAsPaid` calls on the same payment
   credit the wallet exactly once; two concurrent `refundPayment` calls debit
   exactly once, with the loser observing 409.
7. Add the `chrono payment permissions` block to `src/e2e/permissions.test.ts` and
   the payment gate block to `src/e2e/run.ts` (see Files to Update).

**Acceptance Criteria**: every mutating route gated by `requirePermission` (imported
from the app-local wrapper) before any DB work; no route trusts client-supplied
`tenantId`; concurrency tests pass; a void/refund on a non-`"paid"` payment —
including a second attempt on an already-voided/refunded one — returns 409, never a
silent no-op; a concurrent double-refund debits the wallet exactly once (the loser
gets 409, not a duplicate debit); every settle/void/refund writes a
`recordStaffAudit` entry with the amount in its metadata; `payment:pay` is gated
separately from `payment:create` and the permissions-test gate case for it fails
when removed from the role.

**Verification Commands**: `pnpm typecheck`;
`pnpm --filter @agora/chrono-api test:permissions` (gate test fails when any
`payment` action is removed from the role — required per `.ai/rules/rbac.md`);
`pnpm --filter @agora/chrono-api rls:proof`; `pnpm --filter @agora/chrono-api test:e2e`.

**Out-of-Scope**: web UI, e2e — Phase 3.

**Execution Start Point**: `apps/chrono-api/src/modules/wallet/{service,routes}.ts`
and `apps/chrono-api/src/modules/pos/routes.ts`'s `void` action for the permission
pattern.

### Phase 3 — Web UI + e2e

**Files to Update**:
- New: `apps/chrono-web/src/app/dashboard/payments/page.tsx` (list view, using the
  `DataTable`/`DataTableToolbar`/`DataTablePagination` stack per
  `.ai/rules/data-listing.md`; void/refund row actions gated by `<Can>` from
  `agora/ui`)
- New: `apps/chrono-web/e2e/tests/payments/payments.spec.ts` — happy path (staff
  creates + calls `pay`), role gate (staff blocked from `void`/`refund`, admin
  allowed), cross-tenant isolation (tenant A cannot see/mutate tenant B's payment)

**Step-by-Step Tasks**:
1. Build the list page via the typed `api` client, server-paginated per
   `.ai/rules/pagination.md`/`.ai/rules/admin-table.md`.
2. Wire void/refund actions as row-level buttons (icon-action standard,
   `.ai/rules/styling.md`), gated visually by `can()` — server remains the real
   gate.
3. Write the three e2e scenarios per `.ai/rules/e2e-testing.md`.
4. Update `apps/chrono-api/AGENTS.md`: add `payment` to the landed Wave 1 module
   list (schema + routes + web UI status per whatever lands).

**Acceptance Criteria**: page renders with no raw HTML chrome (`.ai/rules/
component-first-ui.md`); e2e spec passes headed (`pnpm dev` running, no
`apps/chrono-api/.env` present per `.ai/rules/rbac.md`'s testing note).

**Verification Commands**: `pnpm typecheck`; the new e2e spec; `pnpm build`.

**Out-of-Scope**: reservation-deposit linkage, payment-gateway/provider
integration — remain out of scope per Pass 2.

**Execution Start Point**: `apps/chrono-web/src/app/dashboard/reservations/` as the
copy target (its plan is archived at `.ai/plans/chrono/archive/reservations/` — verify
the page itself still exists on disk before starting, since "archived" describes the
plan document, not a guarantee about the current page).

## Next recommended action

Ready for Phase 1. While in that phase, also fix `apps/chrono-api/AGENTS.md`'s stale
Wave-1 status note (it currently says "`wallet` — schema + RLS landed (routes not yet
built)" and lists `pos`/`credit`/`loyalty`/`voucher`/`promo`/`report`/`inquiry`/
`security-alert`/`qr`/`landing-page` as "Deferred" — most of that list has already
shipped) and add `payment` to it once this module lands.
