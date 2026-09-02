# Chrono — `payment` module (reconciliation with oikos/karta-tenant)

Status: **Concreteness-Gate ready** — written 2026-09-02 from a reconciliation
review against the current karta-tenant reference (`/Users/risurina/karta/karta-tenant`,
`apps/chrono-api/src/modules/payments/`). Open questions resolved 2026-09-02 (see
"Resolved decisions" below). Not yet audited — send to `plan-auditor` before
implementation per `.ai/rules/feature-planning.md`.

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

**Who uses this**: `staff`/`admin`/`owner` (recording/voiding/refunding a payment at
the counter); `owner` only for refunds (see permission vocabulary below — oikos gates
`refund` to `OWNER` only, `void`/`pay` to `OWNER`+`STAFF`).

**What workflow does oikos's `payments` module enable that agora's `ChronoSalePayments`
doesn't?**

1. **A payment that exists before it's paid.** oikos's `Payment` has a
   `PENDING → PAID/CANCELLED` lifecycle with `expiresAt`/`checkoutUrl`/
   `providerReference` — modeling a payment request that can be created, then
   completed later (e.g. a provider checkout redirect, or a manual payment recorded
   ahead of cash arriving). `ChronoSalePayments` has no such thing — a sale-payment
   row is only ever created already-settled, at checkout time, tied 1:1 to a sale.
2. **A wallet top-up that is not a POS sale.** oikos's `markAsPaid` treats a
   standalone payment with no `sessionId` as a wallet top-up and calls
   `walletService.topUp`. Agora's `wallet:credit` action lets staff credit a wallet
   directly (`apps/chrono-api/src/modules/wallet/routes.ts`), but with **no payment
   record backing it** — there is no `Payment` row, no audit trail of "how much cash
   changed hands, via what method, recorded by whom," separate from the wallet
   ledger entry itself.
3. **Void/refund with side-effect reversal.** oikos's `voidPayment`/`refundPayment`
   both reverse the wallet top-up (`walletService.debit`) or the credit grants a
   payment produced (`reverseSideEffects`, walking `CreditPurchases` →
   `CreditGrants`, refusing to reverse a grant that's already been partially
   consumed). Agora's POS module has its own `void` action
   (`pos: ["read", "sell", "void", "manageProducts"]`) scoped to a sale, and wallet
   has `adjust` for corrections, but nothing that generically reverses "whatever this
   payment funded" the way oikos's `reverseSideEffects` does.
4. **An idempotent event ledger.** `PaymentEvents` with a partial unique index on
   `(tenantId, idempotencyKey)` guards against double-crediting from a replayed
   completion or a future webhook. Agora has this pattern already
   (`chronoCreditGrantLedgerEntry`, `chronoWalletTransaction` — append-only ledgers
   with `balanceBefore`/`balanceAfter`), so this is a "reuse the existing agora
   pattern" item, not new design.

**What does the user see, click, confirm, or wait for?**
A staff member recording a manual payment (cash/card at the counter, not through
POS checkout) — e.g. topping up a customer's wallet directly with cash — sees a
payment recorded, then can void or (owner only) refund it later if it was a mistake,
with the wallet debited back out automatically.

**Failure cases**: double-completion of the same payment (must not double-credit);
voiding/refunding a payment whose funded credit grant has already been partially
consumed (oikos throws — the same rule should apply here); refunding a payment tied
to no wallet/grant (a no-op reversal, not an error); wrong tenant/branch (RLS +
`withTenant`, as everywhere else); role gate (`admin`/`owner` for void, `owner` for
refund — see below).

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
  `sessionId` (nullable FK `chronoSession.id`, set null, once `session` schema
  lands), `amount` (numeric 12,2), `currency` (default from tenant, matching
  `chronoWallet.currency`), `method` (free text, Zod-validated at the contract layer
  — matches the dominant agora convention already used by `chronoWalletTransaction
  .type` and `chronoSalePayment.method`, **not** oikos's Postgres
  `PaymentMethodEnum`), `status` (`"pending" | "paid" | "cancelled"`, same free-text
  convention), `providerReference` (nullable text), `paidAt`/`expiresAt`/
  `createdAt`/`updatedAt`.
- `ChronoPaymentEvents` — `id`, `tenantId`, `paymentId` (FK, cascade), `eventType`
  (free text: `"received" | "cancelled" | "voided" | "refunded"`), `idempotencyKey`
  (nullable text), partial unique index on `(tenantId, idempotencyKey)` where not
  null — copy `chronoCreditGrantLedgerEntry`'s exact idempotency-key pattern.
  `payloadJson` (jsonb, metadata only — reason, actor).
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

**Permission vocabulary** (`apps/chrono-api/src/auth/permissions.ts`,
`CHRONO_PERMISSION_STATEMENTS`):

```ts
payment: ["read", "create", "void", "refund"],
```

- `read`/`create` at staff tier — mirrors `wallet: ["read", "credit", "debit"]`'s own
  precedent (recording a manual payment is routine counter work, same tier as a
  wallet credit).
- `void` at admin+ — mirrors `pos:void`'s existing tier exactly.
- `refund` at admin+ — resolved decision 1 above (not owner-only, despite oikos
  gating this `OWNER`-only).

**Files to touch**:

- New: `apps/chrono-api/src/modules/payment/{schema,contracts,service,routes,concurrency.test}.ts`
- Edit: `apps/chrono-api/src/db/schema.ts` (compose new tables, add to `APP_TENANT_TABLES`)
- Edit: `apps/chrono-api/src/auth/permissions.ts` (add `payment` resource + staff/admin grants)
- Edit: `apps/chrono-api/src/routes/rpc.ts` (mount `paymentRoutes()`)
- Edit: `apps/chrono-api/src/modules/wallet/service.ts` — no schema change, but
  `topUp`/`debit` calls from the new payment service pass `paymentId` through
  `metadata` (matching how `chronoSalePayment.walletTransactionId` already links
  back) so a wallet transaction can be traced to the payment that caused it.
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

**Verification Commands**: `pnpm typecheck`; `pnpm --filter @agora/api rls:proof`
(must print `RLS PROOF: PASS ✅`).

**Out-of-Scope**: routes, service logic, permissions — Phase 2.

**Execution Start Point**: `apps/chrono-api/src/modules/wallet/schema.ts` (copy its
shape) and `apps/chrono-api/src/db/schema.ts`'s existing `APP_TENANT_TABLES` array.

### Phase 2 — Service + routes + permission gates

**Files to Update**:
- New: `apps/chrono-api/src/modules/payment/service.ts` (`createPayment`,
  `markAsPaid`, `voidPayment`, `refundPayment`, `reverseSideEffects` helper)
- New: `apps/chrono-api/src/modules/payment/routes.ts` (`paymentRoutes()` Hono
  factory typed on `TenantVars`)
- New: `apps/chrono-api/src/modules/payment/concurrency.test.ts` (row-lock
  double-completion / double-refund tests, copy `wallet/concurrency.test.ts`'s
  pattern)
- Edit: `apps/chrono-api/src/auth/permissions.ts` — add
  `payment: ["read", "create", "void", "refund"]` to
  `CHRONO_PERMISSION_STATEMENTS`; `payment: ["read", "create"]` to
  `CHRONO_STAFF_GRANTS`; `payment: ["read", "create", "void", "refund"]` to
  `CHRONO_ADMIN_GRANTS`.
- Edit: `apps/chrono-api/src/routes/rpc.ts` — mount `paymentRoutes()`.
- Edit: `apps/chrono-api/src/modules/wallet/service.ts` — accept an optional
  `paymentId` in `topUp`/`debit`'s metadata param (no schema change) so a wallet
  transaction traces back to the payment that caused it.

**Step-by-Step Tasks**:
1. `createPayment` — `status: "pending"`, validated via `createPaymentSchema`.
2. `markAsPaid` — `for update` row lock on `chronoPayment` (mirrors
   `wallet`/`credit` concurrency pattern), idempotent on already-`paid` (return
   existing, no double-credit), inserts a `chronoPaymentEvent` row with
   `idempotencyKey: "manual:${id}:paid"`, calls `walletService.topUp` when
   `memberId` is set and `sessionId` is null.
3. `voidPayment`/`refundPayment` — `for update` lock, reject if not `"paid"`,
   flip to `"cancelled"`, insert the event row, call `reverseSideEffects` (debits
   the wallet top-up via `walletService.debit` when applicable; no-op if the
   payment funded nothing).
4. Routes: `POST /payments`, `GET /payments`, `GET /payments/:id`,
   `POST /payments/:id/pay`, `POST /payments/:id/void`,
   `POST /payments/:id/refund` — `requirePermission` before any DB work on every
   mutating route, `withTenant` for every query.
5. `concurrency.test.ts`: two concurrent `markAsPaid` calls on the same payment
   credit the wallet exactly once; two concurrent `refundPayment` calls debit
   exactly once.

**Acceptance Criteria**: every mutating route gated by `requirePermission`; no
route trusts client-supplied `tenantId`; concurrency tests pass; a `refund` on a
non-`paid` payment 400s; a double-refund is a no-op on the second call, not an
error and not a double-debit.

**Verification Commands**: `pnpm typecheck`;
`pnpm --filter @agora/api test:permissions` (gate test fails when `payment`
permission is removed from the role — required per `.ai/rules/rbac.md`);
`pnpm --filter @agora/api rls:proof`.

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
  creates + marks paid), role gate (staff blocked from `void`/`refund`, admin
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

**Execution Start Point**: `apps/chrono-web/src/app/dashboard/reservations/` (an
already-archived, structurally similar list+action page) as the copy target.

## Next recommended action

Send to `plan-auditor` for a fresh-eyes review against `.ai/rules/*` before
starting Phase 1.
