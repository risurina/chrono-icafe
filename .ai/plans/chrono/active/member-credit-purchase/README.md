# Member portal: buy credits online + see running promos

**Status:** Accepted, with one modification — backend phases C1–C4 and C7
implemented and verified (2026-09-05). Phase C5 (web UI) is **superseded** by
`.ai/plans/chrono/active/member-area/README.md`'s Phase 7 (a separate,
already-running effort implementing `/portal/credits`/`/portal/wallet`), per
this plan's own "Depends on" note above and its Web section. Phase C6 (e2e
spec) is **deferred** until that UI lands — it needs real pages to drive.
This plan stays in `active/`, not archived, until C5/C6 close it out.
**App:** `chrono`
**Depended on (now satisfied):** `.ai/plans/agora/archive/tenant-customer-payments/README.md` (Phases A1–A2, implemented and archived)

## Scope, as decided

- **Payment:** online, via the tenant's own PayMongo account (GCash/card). Not
  wallet-balance-only.
- **Promos:** informational only — the portal lists what's currently running. No promo
  redemption on a credit purchase.

## What already exists (verified, not assumed)

| Piece | State |
|---|---|
| `ChronoCreditProducts` / `Grants` / `Purchases` / `GrantLedgerEntries` | Landed, RLS-forced (`modules/credit/schema.ts`) |
| `purchaseCreditProduct(tx, …)` | Landed and concurrency-tested — atomic wallet debit → grant → ledger → purchase row (`modules/credit/service.ts:204`) |
| `creditWallet` / `debitWallet` | Landed (`modules/wallet/service.ts:101,117`) |
| `ChronoPayments` + `ChronoPaymentEvents` | Landed. `chronoPaymentEvent.idempotencyKey` already carries a partial unique index on `(tenantId, idempotencyKey)`, commented as *"forward-provisioning for a future provider-webhook replay"* (`modules/payment/schema.ts`) — this plan is that webhook |
| `ChronoPromos` | Landed, but scoped to **POS sales** — `ChronoPromoRedemptions.saleId`, and `validatePromoSchema` requires `branchId` + `subtotal` |
| `/portal/wallet/{balance,history}`, `/portal/credits/{balance,ledger}` | Landed, **read-only** |
| Member portal UI | `/portal` is one 362-line component (`portal/tenant-portal-home.tsx`) that literally tells the customer *"Visit the business counter to top up your wallet"* |

**Nothing exists for:** a member-facing product catalog, member self-purchase, any
top-up path, or any customer-facing PSP.

## Pass 1 — Workflow analysis

**Actor:** a tenant customer (`tenantMember`) with a portal session, on
`{slug}.APP_DOMAIN/portal/*`. Membership *approval* is not required to buy — an
unapproved member already "plays at standard rates" per the existing copy, so gating
purchases on approval would be a new restriction; approval affects pricing, not
purchasing.

**Happy path.** `/portal/credits` lists active packs (name, minutes, price, validity,
which station group if restricted) → **Buy** → server creates a pending
`ChronoPayments` row and a PayMongo checkout session → browser redirects to PayMongo's
hosted page → customer pays → redirected back to `/portal/credits?payment=<id>` which
polls the intent → PayMongo's webhook fulfils it server-side → the page flips to "250
minutes added" and the credit balance card refreshes.

**Fulfilment is webhook-only.** The success redirect never grants anything — it is a
client-controlled URL. This is the single most important rule in this plan.

**Failure cases and what the customer sees.**

| Failure | Behaviour |
|---|---|
| Tenant has no payment integration | Catalog renders with online-buy disabled and "Ask staff at the counter to add credits." Never a broken button. |
| Customer abandons the hosted page | Intent stays `pending` until `expiresAt`; a swept/expired intent shows as "Payment not completed." No credits, no charge. |
| Webhook delayed | Return page polls with a bounded backoff, then shows "Payment received — credits are being added. Refresh in a moment." Never claims failure for a paid intent. |
| Webhook replayed (PayMongo retries) | Second delivery is a no-op via the existing `idempotencyKey` unique index. Exactly-once fulfilment. |
| Paid amount ≠ intent amount | **Not fulfilled.** Payment marked `voided` with a note, audit row written, 200 returned so PayMongo stops retrying. Staff resolves manually. |
| Product archived or repriced between intent and payment | Fulfilled as a **wallet top-up only** — the customer keeps the money as balance — with `fulfilmentNote` set for staff. See "The two rollback traps". |
| Forged/unsigned webhook | 400, nothing written. |
| Cross-tenant | The webhook token resolves exactly one tenant; every read/write is `withTenant`. A customer of tenant A can never see or buy tenant B's packs. |

**Audit.** Fulfilment, amount-mismatch rejection, and degraded fulfilment each write an
audit row. A member-initiated checkout is *not* staff-audited (`recordStaffAudit` needs
a staff actor); it is recorded as a `ChronoPaymentEvents` row, which is the customer-side
trail.

### The two rollback traps

Both are the same shape and both would be live bugs if not designed out. If anything
inside the fulfilment transaction throws **after** money has already been taken, the
transaction rolls back, the webhook 500s, PayMongo retries forever, and the customer is
charged with nothing to show.

1. **Price drift.** `purchaseCreditProduct` reads the *current* `product.priceAmount`
   for its wallet debit. If the price rose after the intent was created, the debit
   exceeds the credited amount, `debitWallet`'s non-negative guard throws, everything
   rolls back.
   **Fix:** give `purchaseCreditProduct` an optional `chargeAmount` argument (default
   `product.priceAmount`, so every existing caller and its concurrency tests are
   unchanged) used for both the debit and the purchase-row snapshot. Fulfilment passes
   the intent's snapshotted amount — the customer is charged what they agreed to.
2. **Product no longer sellable.** `purchaseCreditProduct` throws 409 when
   `status !== "active"`. Same rollback, same retry storm.
   **Fix:** the fulfilment service catches a *domain* failure from the credit step
   (never an infrastructure failure — those must still roll back and be retried),
   commits the wallet credit alone, sets `fulfilmentNote`, and returns 200.

## Pass 2 — Technical design

### Schema: extend `ChronoPayments`, do not add a table

`chronoPayment` already models exactly this row — member, amount, currency, method,
`pending|paid|voided|refunded`, `providerReference`, `paidAt`, `expiresAt` — and
`chronoPaymentEvent` already has the idempotency index. A parallel
`ChronoCustomerPaymentIntents` table would split the payment ledger in two, which the
`reconciliation` module would then have to union. Three additive nullable columns
instead:

```ts
// modules/payment/schema.ts
purpose: text("purpose"),                       // "credit_purchase" | "wallet_topup" | null (legacy/cash rows)
creditProductId: text("creditProductId")        // set only when purpose = "credit_purchase"
  .references(() => chronoCreditProduct.id, { onDelete: "set null" }),
fulfilledAt: timestamp("fulfilledAt"),
fulfilmentNote: text("fulfilmentNote"),
```

Plus `index("chrono_payment_purpose_idx").on(t.purpose)`.

`chronoPayment` is already in `APP_TENANT_TABLES` and RLS-forced, so **no RLS
registration change** — but the migration is still generate-and-migrate, never
`db:push` (`.ai/rules/database.md`).

> Import direction check: `modules/payment/schema.ts` already imports
> `../session/schema`; adding `../credit/schema` introduces no cycle, since
> `modules/credit/schema.ts` imports `../station/schema` and `../wallet/schema` only.

### Routes

**Member portal** — `modules/payment/portal-routes.ts` (new), mounted
`.route("/portal/payments", paymentPortalRoutes())` in `app.ts` beside the existing
`/portal/*` mounts (`app.ts:530-545`), under `memberMiddleware()`:

- `GET /portal/payments/gateway` → `{ available: boolean, currency }` so the UI can
  disable online-buy honestly.
- `POST /portal/payments/checkout` → body `{ purpose, productId?, amount? }`.
  `memberId` and `tenantId` come from `c.var.member`, **never** the body.
  - `credit_purchase`: price read server-side from the product; body carries no amount.
  - `wallet_topup`: `amount` is client-supplied and therefore bounded by contract
    (min ₱20, max ₱10,000) *and* re-verified against the PSP-reported amount at
    fulfilment.
  - Rate-limited: 10 / 15 min per member (a checkout creates a DB row and an outbound
    PSP call).
  - Returns `{ paymentId, checkoutUrl }`.
- `GET /portal/payments/:id` → the caller's **own** payment only
  (`memberId = c.var.member.memberId` in the WHERE, not just tenant scope), narrowed to
  `{ id, status, purpose, amount, currency, fulfilledAt, createdAt }`.

**Member catalog** — added to the existing `modules/credit/portal-routes.ts`:
`GET /portal/credits/products` → active products only, explicit allowlist
(`id, name, quantityMinutes, priceAmount, currency, validityDays, creditPolicy, stationGroupId`).
No `code`, no timestamps.

**Promos** — `modules/promo/portal-routes.ts` (new), mounted `/portal/promos`:
`GET /` → `status = "active"` AND `endsAt > now()` AND (`startsAt IS NULL` OR
`startsAt <= now()`), allowlisted to
`{ id, name, description, discountType, discountValue, minSpend, endsAt, branchId, code }`.
`maxRedemptions` and redemption counts are **not** exposed — that is the tenant's
commercial data.

**Webhook** — `POST /payments/customer/webhook/:token` mounted directly on the app
outside `/rpc`, beside `/billing/webhook` (`app.ts:772`), per Chrono's own
"Unauthenticated routes" convention. Raw body read with `c.req.text()` **before** any
body middleware. Rate-limited 120 / min by `clientIp`.

Order of operations, and it matters:

1. `findTenantByCustomerPaymentWebhookToken(token)` → 404 if unknown.
2. `resolveCustomerPaymentWebhookSecret(tenantId)` → verify HMAC → 400 if invalid.
3. `parse(payload)` → 400 if unparseable; ignore-with-200 for event types we don't handle.
4. Cross-check `parsed.tenantId` against the path-resolved tenant → 400 on mismatch.
5. Insert `chronoPaymentEvent` `{ idempotencyKey: parsed.eventId, payloadJson }`
   `onConflictDoNothing`. **Zero rows inserted → return 200 immediately.** This is the
   idempotency gate, and it comes before any fulfilment.
6. Fulfil (below).
7. Return 200 fast.

### Fulfilment service

`modules/payment/fulfilment.ts` (new) — `fulfilCustomerPayment(tx, { tenantId, parsed })`,
one `withTenant` transaction:

1. Load the `chronoPayment` row by id (`parsed.referenceId`) `FOR UPDATE`. Missing →
   audit + 200 (nothing to retry).
2. Already `paid` → no-op (belt to step 5's braces).
3. Status must be `pending`; amount and currency must match the row's snapshot.
   Mismatch → `voided` + `fulfilmentNote` + audit, return.
4. `creditWallet(tx, { amount: row.amount, reason: "Online payment", referenceType: "online_payment", referenceId: row.id })`.
5. If `purpose === "credit_purchase"`: `purchaseCreditProduct(tx, { tenantId, memberId, productId, chargeAmount: row.amount })`. On a `HttpError` (domain refusal — archived/repriced product), swallow it, set `fulfilmentNote`, and keep the wallet credit. Any non-`HttpError` rethrows so the transaction rolls back and PayMongo retries.
6. Mark the payment `paid` with `paidAt`, `fulfilledAt`, `method` from the parse.

The wallet is credited then immediately debited for a pack purchase — net zero balance
change, two truthful ledger entries, and **one** fulfilment path that reuses the
already-concurrency-tested `purchaseCreditProduct` instead of forking a second grant
minter.

### Contracts

`modules/payment/contracts.ts` gains `paymentPurposeSchema`,
`createCheckoutSchema` (with a `.refine` that `productId` is present iff
`purpose === "credit_purchase"`, and `amount` present iff `wallet_topup`), and the
narrowed DTOs. `modules/promo/contracts.ts` gains `portalPromoDtoSchema`.
Both per `.ai/rules/dto.md` — no raw `$inferSelect` reaches the client.

### Web

- `app/(member-portal)/portal/credits/page.tsx` — pack catalog, Buy, and the
  `?payment=<id>` return/poll state.
- `app/(member-portal)/portal/wallet/page.tsx` — balance, history, Top up.
- `components/portal/promos-card.tsx` — running promos, rendered on `/portal`.
- `lib/payments-portal.ts` — typed client helpers, matching `lib/credits-portal.ts`.

Built **only** from `agora/ui` primitives (`.ai/rules/component-first-ui.md`), each
root carrying a `data-testid`. Mutations use `toast`.

> The existing `portal/tenant-portal-home.tsx` is full of raw `div`/`ul`/`h1` chrome and
> violates that rule today. **Not fixed here** — it is untouched except for mounting the
> promos card and linking to the two new pages. Its cleanup is a separate chore, noted
> so it isn't mistaken for a pattern to copy.
>
> The promos card copy must say **where** a promo applies (counter/POS purchases), since
> promos do not discount credit packs. A card that implies otherwise is a lie to the
> customer, not a cosmetic issue.

### Files

**New:** `modules/payment/portal-routes.ts`, `modules/payment/fulfilment.ts`,
`modules/payment/fulfilment.test.ts`, `modules/promo/portal-routes.ts`,
`app/(member-portal)/portal/credits/page.tsx`,
`app/(member-portal)/portal/wallet/page.tsx`,
`components/portal/promos-card.tsx`, `lib/payments-portal.ts`,
`e2e/tests/portal-credits/purchase.spec.ts`

**Modified:** `modules/payment/schema.ts`, `modules/payment/contracts.ts`,
`modules/credit/portal-routes.ts`, `modules/credit/service.ts` (the `chargeAmount`
argument), `modules/promo/contracts.ts`, `src/app.ts` (three mounts + two limiters),
`portal/tenant-portal-home.tsx`, `src/e2e/run.ts`, `apps/chrono-api/AGENTS.md`,
`apps/chrono-api/.env.example`

## Phases

### Phase C1 — Schema + migration — ✅ done (2026-09-05, commit `288dc3ec`)
`modules/payment/schema.ts`. Add the four columns + the index; `pnpm db:generate --name
chrono_payment_customer_purpose` then `pnpm db:migrate`. Review the generated SQL for
destructive ops before applying.
**Accept:** columns exist, all nullable, no existing row rewritten.
**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅`

### Phase C2 — Contracts + `chargeAmount` — ✅ done (2026-09-05, commit `03fa648b`)
`modules/payment/contracts.ts`, `modules/promo/contracts.ts`,
`modules/credit/service.ts`.
**Accept:** `purchaseCreditProduct` takes an optional `chargeAmount`; every existing
caller compiles unchanged and `modules/credit/concurrency.test.ts` still passes
untouched. A new unit case proves an explicit `chargeAmount` is what gets debited and
snapshotted.
**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-api test`

### Phase C3 — Fulfilment service (offline-testable) — ✅ done (2026-09-05, commit `0e008e45`)
`modules/payment/fulfilment.ts` + `fulfilment.test.ts`. No routes yet, so this phase is
pure logic and fully unit-testable.
**Accept:** tests cover — happy pack purchase; happy top-up; replay is a no-op;
amount mismatch voids and does not grant; currency mismatch voids; archived product
degrades to a wallet credit with a note and **commits**; an infrastructure error
rethrows and rolls back; a missing payment row is a no-op.
**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-api test`

> **Deviation (C2/C3/C4 verify commands):** this repo has no generic `test`
> script — every module test is its own standalone tsx script
> (`.ai/rules/testing.md`'s existing convention). C2's chargeAmount case was
> added to `test:credit-concurrency`; C3 shipped as `test:payment-fulfilment`
> (PGlite-backed, offline); C4's route-level coverage shipped as
> `test:payment-portal-routes` (TEST_DATABASE_URL-backed, mirrors
> `modules/qr/routes.test.ts`). The enforced `test:e2e` suite could not be
> run for C4 in this session — it failed with a pre-existing, unrelated
> Postgres role-ownership error (`must be owner of table Accounts`) against
> the shared `TEST_DATABASE_URL`, traced to another concurrent effort's
> migration on that same database, not to this plan's changes. `rls:proof`
> and the dedicated route-level test above both passed.

### Phase C4 — Portal routes + webhook — ✅ done (2026-09-05, commit `10ac891f`)
`modules/payment/portal-routes.ts`, `modules/credit/portal-routes.ts`,
`modules/promo/portal-routes.ts`, `src/app.ts`.
**Accept:** catalog, checkout, poll, promos, and the webhook all work against a stub
gateway injected with `__setCustomerPaymentGateway`. Rate limits are concrete numbers
at the mount site. No route returns a raw row. An anonymous caller 401s on every
`/portal/*` route; the webhook needs no session but 404s on a bad token.
**Verify:** `pnpm typecheck` · `rls:proof` · `pnpm --filter @agora/chrono-api test:e2e`

### Phase C5 — Web UI — **superseded, not built here**
**Superseded by** `.ai/plans/chrono/active/member-area/README.md`'s Phase 7, a
separate, already-running effort implementing the `/portal/*` member-area
pages (including `/portal/credits` and `/portal/wallet`). This backend-only
pass (C1–C4, C7) deliberately does not touch any `apps/chrono-web/src/app`
files under `/portal/credits` or `/member/*` — that surface belongs entirely
to that other effort. The two pages, the promos card, the client helpers, and
the home-page links described below are that effort's responsibility, not a
future phase of this plan.
~~The two pages, the promos card, the client helpers, and the home-page links.~~
~~**Accept:** a member can buy a pack end to end on `{slug}.localtest.me:3000/portal/credits`;~~
~~online-buy is disabled with honest copy when the tenant has no gateway; the return page~~
~~never claims success before the webhook lands.~~
~~**Verify:** `pnpm typecheck` · manual walkthrough~~

### Phase C6 — E2E spec — **deferred until Phase C5's UI lands**
Deferred, not skipped: this spec drives real `/portal/credits` pages that
Phase C5 (now `member-area` Phase 7) has not yet shipped. Add it as a
follow-up pass once that UI lands — the backend surface it needs
(`/portal/payments/*`, the webhook, `/portal/credits/products`,
`/portal/promos`) is already in place and covered by this plan's own
`fulfilment.test.ts` / `portal-routes.test.ts`.

Original spec, to build once the UI exists —
`apps/chrono-web/e2e/tests/portal-credits/purchase.spec.ts`, per
`.ai/rules/e2e-testing.md` — happy path, gate, **and** isolation, all three required:
1. A member buys a pack; credits appear only after the simulated webhook.
2. **Gate:** an anonymous visitor is redirected off `/portal/credits`; a member cannot
   poll another member's payment id (404, not 403 — no existence leak).
3. **Isolation:** a member of tenant A never sees tenant B's packs or promos, and a
   webhook signed with tenant B's secret carrying tenant A's payment id is refused.
   This is the only real proof for the `withAdmin` token lookup, which `rls:proof`
   does not cover.
4. Replay: the same webhook delivered twice grants once.

Data via `@faker-js/faker`, `test-` prefixed.
**Verify:** the spec passes with `pnpm dev` running · `pnpm typecheck` · `rls:proof`

### Phase C7 — Docs — ✅ done (2026-09-05, commit `06da417c`)
`apps/chrono-api/AGENTS.md` (the new `/portal/payments/*` surface + the webhook
under "Unauthenticated routes"), `.env.example`, and
`docs/runbooks/customer-payment-webhook.md` on registering the webhook URL in
PayMongo and what an amount-mismatch/degraded-fulfilment row means.

## CRUD & feedback contract

| Entity | C | R | U | D |
|---|---|---|---|---|
| Payment intent (member) | ✅ checkout | ✅ own only | webhook only | ✗ — voided, never deleted |
| Credit product (member) | ✗ | ✅ active only | ✗ | ✗ |
| Promo (member) | ✗ | ✅ running only | ✗ | ✗ |

No deletes anywhere on this surface. Every member-facing mutation surfaces a toast;
every fulfilment outcome other than plain success writes an audit row.

## Out of scope

- **Promo redemption on a credit purchase.** Decided: informational only. Would need a
  credit-purchase reference on `ChronoPromoRedemptions` and a branch-less validation
  path — its own plan if wanted later.
- **Refunds of customer payments**, including what happens to an already-consumed
  grant. Deferred with the foundation plan.
- **Recurring membership plans** (the deferred `tenant-customer-membership-plans`
  foundation plan).
- **A pending-intent expiry sweep.** Stale `pending` rows are harmless (nothing was
  charged) and the reservation module's sweep is the pattern to copy when it's wanted.
- **Rewriting `tenant-portal-home.tsx`** to be component-first.
- **Staff-side UI** for reviewing mismatched/unfulfilled payments. The rows and audit
  trail exist; the dashboard view is follow-up work.

## Open question for the developer

Membership **approval** is deliberately not required to buy credits (an unapproved
member already plays at standard rates, so blocking purchase would be a new
restriction). If Chrono should instead require `applicationStatus === "approved"`
before an online purchase, say so before Phase C4 — it is a one-line guard in the
checkout route, but a behaviour decision, not a technical one.

## Execution start point

Phase C1, `apps/chrono-api/src/modules/payment/schema.ts` — **after** foundation Phases
A1–A2 land, since C4 imports `resolveCustomerPaymentGateway`. C1–C3 have no dependency
on the foundation work and can proceed in parallel with it.
