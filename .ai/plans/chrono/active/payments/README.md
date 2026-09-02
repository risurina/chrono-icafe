# Chrono — `payment` module (reconciliation with oikos/karta-tenant)

Status: **Draft** — written 2026-09-02 from a reconciliation review against the
current karta-tenant reference (`/Users/risurina/karta/karta-tenant`,
`apps/chrono-api/src/modules/payments/`). Not yet audited or accepted. Per
`.ai/rules/feature-planning.md`, do not implement until this is reviewed and the
open questions below are resolved.

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
- No `reservationId`/`shiftId` FK columns yet — agora's `reservation` module has
  landed (archived plan) but linking a payment to a reservation deposit is new scope
  beyond what's being reconciled here; add the FK in a later phase if/when a
  reservation-deposit workflow is actually requested. Flagged as Open Question 3.

**Permission vocabulary** (`apps/chrono-api/src/auth/permissions.ts`,
`CHRONO_PERMISSION_STATEMENTS`):

```ts
payment: ["read", "create", "void", "refund"],
```

- `read`/`create` at staff tier — mirrors `wallet: ["read", "credit", "debit"]`'s own
  precedent (recording a manual payment is routine counter work, same tier as a
  wallet credit).
- `void` at admin+ — mirrors `pos:void`'s existing tier exactly.
- `refund` at admin+ — oikos gates this `OWNER`-only (stricter than `void`'s
  `OWNER`+`STAFF`); agora's nearest precedent is `wallet:adjust`/`credit:adjust`,
  both admin+ (not owner-only). **Open Question 1**: does this repo want a
  `owner`-only `refund` tier (matching oikos) or does it fold into the standard
  admin+ `adjust`-tier precedent used everywhere else in Chrono? Recommend the
  latter for consistency unless there's a specific reason to diverge (a refund here
  is not materially higher-risk than `wallet:adjust`, which is already admin+).

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

## Open Questions

1. **Refund permission tier** — admin+ (consistent with `wallet:adjust`) vs.
   owner-only (matching oikos's stricter gate)? See above. Recommend admin+.
2. **Is this even needed now, or later-wave?** `AGENTS.md`'s Wave 1 list doesn't
   include `payment` at all — it predates this reconciliation. Does the developer
   want this scheduled now (Wave 1, since `wallet`/`credit`/`pos` already exist and
   this closes a real audit-trail gap under them), or filed as a later wave alongside
   `loyalty`/`vouchers`/`promos`? Recommend Wave 1 — a wallet top-up recorded via
   `wallet:credit` today has **no** payment-method/counter-audit trail at all, which
   is a real gap under the modules already shipped, not a nice-to-have.
3. **Reservation-deposit linkage** — defer to a future phase, or fold in now since
   `reservation` already exists? Recommend defer (no product requirement stated yet
   for deposits).
4. **`AGENTS.md` update** — once this plan is accepted, `apps/chrono-api/AGENTS.md`'s
   module list should be updated to include `payment` (it currently has no mention of
   it at all, in either the landed or deferred sections) so the next reconciliation
   pass doesn't rediscover the same gap.

## Phase Design (pending acceptance of the Open Questions above)

Not yet broken into Concreteness-Gate-ready phases — that's the next step once the
developer resolves Open Questions 1–3 above (they change the schema/permission
shape). Sketch, subject to revision:

- **Phase 1** — schema + RLS (`ChronoPayments`, `ChronoPaymentEvents`,
  `APP_TENANT_TABLES`), contracts.
- **Phase 2** — service + routes (create/pay/void/refund), permission gates,
  `concurrency.test.ts` (row-lock double-completion/double-refund).
- **Phase 3** — web UI (`/dashboard/payments`) + e2e spec.

## Next recommended action

Developer review of Open Questions 1–2 (permission tier, wave placement) before this
is broken into implementation-ready phases and audited.
