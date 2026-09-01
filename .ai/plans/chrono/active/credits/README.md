# Chrono — `credits` module

**Depends on:** `stations` (plan done/committed `557b43e`, not implemented) — a credit
lot is optionally scoped to a `ChronoStationGroups` row (the pricing-tier grouping
`stations`' own plan established, importing `chronoStationGroup` from
`apps/chrono-api/src/modules/station/schema.ts`). `members` (plan done/committed
`00ef2aa`, not implemented) — a lot belongs to a `tenantMember.id`, same anchor `wallet`
used. `wallet` (plan done/committed `34c4457`, not implemented) — this plan calls
wallet's exported `debitWallet()`/`creditWallet()` helpers for the cash side of a
purchase/refund, and reuses its row-lock transaction-integrity **pattern** for the
credit-lot ledger's own balance mutations (see "Relationship to `wallet`" in Pass 2 for
why the tables stay separate while the mechanism doesn't). None of the three has landed
code on disk yet (`apps/chrono-api/src/modules/` today has `branch/`, `member/`,
`station/` — the last of those has a schema file but is not yet wired into
`apps/chrono-api/src/db/schema.ts`/`APP_TENANT_TABLES`, and no `wallet: [...]`/
`station: [...]`/`session: [...]` entries exist in
`packages/agora/src/auth/permissions.ts` yet either). This plan is written against those
plans' documented shapes, same as `sessions`' own plan did against `stations`/`members`/
`wallet` before any of them had landed — the implementor builds this module after (or
alongside, phase-by-phase) those tables/helpers actually exist.

**`sessions` is already committed (`6f10812`) and deliberately does not consume this
module.** Its own "Critical scope finding" cut the entire lot-based credit system as a
separate, `stations`-dependent plan (this one) and ships a single wallet-cash-only debit
at session close. This plan does **not** amend `sessions` — see "Scope decision:
session-billing integration" in Pass 2 for the explicit, justified call and a fully
specified (but unbuilt) recommendation for whoever picks up that follow-up later.

## What this is

Credits are Chrono's **lot-based time-entitlement system** — pre-purchased or
staff-granted blocks of gaming minutes (e.g. "10 Hour Gold Pass") a customer holds and
spends down, distinct from the cash `ChronoWallets` balance `wallet` already built. Each
purchase or grant creates its own **lot** (a `ChronoCreditGrants` row) with its own
remaining balance, optional expiry, and an optional **station-group scope** — a lot sold
as "Gold tier" can be restricted to Gold-tier stations only, or left spendable anywhere.
Multiple lots per customer are consumed in a deterministic priority order, never as one
merged number.

This plan builds the **credit-lot ledger only**: product catalog (admin-defined sellable
packs), purchase (wallet-funded, mirroring how `wallet`/`agora/billing` has no other
payment rail yet), manual grant/adjustment (staff corrections and comps), a real
background expiry sweep (oikos never wired one — see "Known oikos weaknesses this plan
fixes" below), and read views (member summary + ledger, staff and portal). It does
**not** wire consumption into `sessions`' billing close — that integration is
deliberately deferred (see Pass 2).

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Owner / Admin** — defines the sellable product catalog (name, minutes, price,
  optional station-group scope, optional validity window) at
  **Dashboard → Credits → Products**, flips a product `draft` → `active` before it's
  sellable, and performs corrections: voiding a grant or a purchase, manually granting
  free minutes (a comp).
- **Staff** — the day-to-day counter operation: sells an active product to a customer
  (charges their wallet, issues the lot), and — mirroring `wallet`'s own staff/admin
  split — can also record a manual **consume** (spend down an existing lot without a
  session, e.g. reconciling a walk-in that used a kiosk this codebase doesn't pair with
  `sessions` yet) since that's a spend-down action, not a correction or a config change.
  Staff **cannot** create/edit products, grant free minutes, or void/adjust an existing
  lot — those are corrections/config, admin+ only, same tier split `wallet` drew between
  `credit`/`debit` (staff) and `adjust` (admin+).
- **Customer (portal)** — views their own active lots (remaining minutes, expiry, which
  station group each is scoped to) and ledger history from `/portal`, read-only. No
  self-service purchase in this pass — same deferral `wallet` made (online purchase needs
  a payment-gateway integration that doesn't exist yet; a staff-sold, wallet-funded
  purchase is the only path).
- **Platform admin (`/rpc-admin`)** — not built in this pass, same as every prior Chrono
  module.

**Workflow:** Admin opens **Dashboard → Credits → Products**, creates "10 Hour Regular"
(600 minutes, ₱500, no station-group scope — spendable anywhere) and "5 Hour Gold"
(300 minutes, ₱400, scoped to the Gold station group, `strict_group_only` policy),
activates both. A customer approaches the counter wanting the Gold pass; staff opens
**Dashboard → Credits**, finds the member, clicks **Sell**, picks "5 Hour Gold" — the
customer's wallet is charged ₱400 and a new 300-minute lot appears, expiring per the
product's validity window if one is set. The member's detail view shows both any prior
lots and this new one, each with its own remaining balance, scope badge, and expiry. An
admin can **Grant** free minutes (no charge — a comp, mandatory reason) or **Void** a lot/
purchase (a correction). The customer's `/portal` page shows their lots and ledger
read-only on next load.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` / `memberMiddleware()` before any
  Chrono code runs.
- Staff attempting product create/edit, grant, or void/adjust → 403, gated by
  `requirePermission`.
- Selling a `draft`/`archived` product → **409** `"This product is not available for
  sale."`
- Selling a product whose price exceeds the customer's wallet balance → **422**
  `"Insufficient wallet balance"` (bubbles verbatim from `debitWallet`'s own guard — this
  plan never reimplements that check, it composes `wallet`'s).
- Creating a product with `creditPolicy: "strict_group_only"` and no `stationGroupId` →
  **400** (a strict-group lot with nothing to scope it to is a contradiction — caught at
  the Zod layer, see Contracts).
- Adjusting (subtracting) more than a grant's `remainingQuantity` → **422**
  `"Adjustment exceeds remaining balance."` (mirrors `wallet:debit`'s insufficient-balance
  guard, applied to a minute balance instead of a cash one).
- Voiding a purchase whose lot has already been partially spent → **409**
  `"This purchase has already been partially used and cannot be voided — void the
  remaining balance on the grant instead."` (a deliberate, simpler alternative to
  pro-rated refund math nobody asked for — see Pass 2, "Void semantics").
- Mutating a `memberId`/`productId`/`grantId`/`purchaseId`/`stationGroupId` that doesn't
  belong to the caller's tenant → **404**, never 403 (no existence leak) — every mutating
  route looks the referenced row up **inside** the same `withTenant` transaction before
  acting on it, the identical closure `wallet`'s Pass 1 mandated for `memberId` and
  `stations`' Pass 2 mandated for a payload `branchId` — this plan applies the same
  discipline to every foreign id it accepts, not just one.
- **Tenant-isolation leak scenario**: tenant A sells a Gold pass to its own customer;
  tenant B's Credits list/member-summary must never show that lot, and tenant B staff
  hitting tenant A's `grantId` directly on any mutating route 404s.
- **Concurrency — the core hazard this plan exists to prevent, same shape as `wallet`'s
  and `sessions`'**: two staff double-clicking "Sell" on the same member, or a manual
  consume racing a future session-close consume (once the deferred `sessions` amendment
  lands), must never double-issue a lot or lose a decrement across two lots being spent
  concurrently. Every balance-mutating call locks every grant row it touches with
  `SELECT ... FOR UPDATE` inside a single DB transaction — proven by a dedicated
  concurrency test in Phase 3, not just asserted in prose.
- Stale screen: two staff viewing the same member's credit summary — last write wins on
  display (the transactional row lock inside each mutation is what makes the balance
  itself safe, not client-side staleness detection — matches `wallet`'s own framing).

**Audit / notifications:** every product create/update, sell, manual grant, adjust, and
void writes a `recordStaffAudit` entry (`chronoCredit.productCreated` /
`.productUpdated` / `.purchased` / `.granted` / `.adjusted` / `.grantVoided` /
`.purchaseVoided`), each capturing the quantity/amount involved — matching `wallet`'s own
"an amount must be in the audit entry, not just the action name" principle. The
background expiry sweep does **not** write a `recordStaffAudit` entry (there is no staff
actor) — mirroring `sessions`' own precedent that its expiry sweep's `closeSession` calls
skip the route-level audit call too; the immutable `ChronoCreditGrantLedgerEntries`
`expired` row is the durable record of what happened. No transactional email in this
pass, matching every prior module's "not required to ship the workflow" call.

---

## Pass 2 — Technical Planning

### What a "credit" is, confirmed from oikos (source of truth for "what exists")

Research against `C:\Users\ronni\project\izur\oikos`
(`apps/chrono-api/src/database/schema/credits.ts`,
`apps/chrono-api/src/modules/credits/**`) confirms: a "credit" is **not** a single
scalar balance. It is a **lot-based entitlement ledger**, seven tables in oikos:
`CreditProducts` (sellable package definitions), `CreditProductGrantRules` (a product can
fan out into N grant rules — e.g. one purchase yielding both Regular and VIP minutes),
`CreditPurchases` (one row per sale), `CreditGrants` (the actual lot — `originalQuantity`/
`remainingQuantity`, the balance), `CreditGrantLedgerEntries` (audit trail),
`UsageEvents` (session billing ticks), and `CreditApplications` (how a tick was paid —
part wallet, part one grant, part another).

**Confirmed answers to the specific questions this plan was asked to resolve:**

- **Consumption order**: deterministic, not simple FIFO-by-expiry alone. oikos's
  `credit-application.service.ts` scores each eligible grant (station-group match +
  `creditPolicy`, see below), then breaks ties by `priority` ascending, then `expiresAt`
  ascending (soonest-expiring first — a real FEFO policy among equally-eligible lots),
  then `createdAt` ascending. This plan ports that ordering (Pass 2, "Consumption
  algorithm" below).
- **Expiry**: yes, a lot has an optional `expiresAt`. Unused balance is **forfeited**, not
  refunded — confirmed in oikos's `expireCreditGrants()`, and this plan keeps that
  behavior (a "your pass expired" outcome is standard for this product category), but
  fixes the real bug found alongside it — see "Known oikos weaknesses this plan fixes"
  below.
- **Station-group/tier scoping — yes, exactly as the task asked**: `CreditGrants` carries
  its own `deviceGroupId` (a station-group FK, copied from the grant rule at issue time,
  not just referenced) and `creditPolicy` (`STRICT_GROUP_ONLY | CONVERT_BY_VALUE |
  ANY_STATION`, confirmed verbatim from `apps/chrono-api/src/database/schema/enums.ts`).
  `STRICT_GROUP_ONLY` makes a "10 hour Gold pass" genuinely unusable at a Silver station —
  the eligibility scorer in `credit-application.service.ts` assigns such a grant score
  `99` (ineligible) outside its own group and it is silently skipped. `CONVERT_BY_VALUE`
  is the richer case — a cross-tier lot converts its remaining minutes to a cash value at
  its own rate, then back to minutes at the target tier's rate — deliberately **not**
  ported in this pass (see "Deliberately narrowed" below).

### Relationship to `wallet` — reuses its pattern, calls its helpers, does not share its tables

`wallet`'s own plan already established, from the same oikos research this plan repeats:
**wallet and credits are two genuinely separate balance systems**, not the same balance
under two names. That finding holds here too, and this plan makes the same call `wallet`
recommended: separate tables, because a credit balance isn't a single scalar — it's many
independent lots with their own expiry/scope/priority, a structurally different shape
than `ChronoWallets.balance`. Merging them into one table would either lose per-lot
scoping or force every wallet read to understand lot semantics it doesn't need.

What **is** reused, per this task's explicit instruction not to invent a second
mechanism for the same problem:

1. **The transaction-integrity pattern.** Every balance mutation in this module —
   granting, purchasing, consuming, adjusting, voiding, expiring — funnels through an
   internal `applyGrantDelta` helper that locks the affected `ChronoCreditGrants` row(s)
   with `SELECT ... FOR UPDATE` inside a single `withTenant` transaction, computes the new
   `remainingQuantity` from the **locked** row, and writes a
   `ChronoCreditGrantLedgerEntries` row in the same transaction — the identical shape to
   `wallet`'s `lockWalletForUpdate` / `applyWalletDelta`, just locking N candidate rows
   (one lot at a time, in priority order) instead of exactly one wallet row. The exported
   wrappers (`purchaseCreditProduct`, `grantCreditsManually`, `consumeCredits`,
   `adjustCreditGrant`, `voidCreditGrant`, `voidCreditPurchase`) all take an
   **already-open `tx`**, never open their own transaction — the same discipline that
   lets `wallet`'s `debitWallet` compose into a caller's larger atomic operation, applied
   here so a future `sessions` amendment (see below) could call `consumeCredits` inside
   its own `closeSession` transaction exactly the way it already calls `debitWallet`.
2. **`debitWallet()`/`creditWallet()` themselves, at the one point cash genuinely
   changes hands.** A purchase is wallet-funded (see "Purchase flow" below) — this plan
   calls `wallet`'s exported helpers for that debit rather than re-deriving wallet
   mutation logic, and a purchase void's refund calls `creditWallet()` the same way. This
   is the one legitimate integration seam between the two modules; everything else about
   a credit lot's own balance (grant/consume/adjust/expire) has nothing to do with cash
   and uses this module's own `applyGrantDelta`, not wallet's.

### Known oikos weaknesses this plan fixes (not blindly ported)

Per `apps/chrono-api/AGENTS.md`'s explicit brief to improve on oikos, not replicate it:

1. **The expiry sweep is never scheduled anywhere in oikos.** `expireCreditGrants()`
   exists and is correct, but no cron/interval/job registers it — `CreditGrants.status`
   never actually flips to `EXPIRED` in a running oikos system. This is partially masked
   at spend-time (the eligibility query filters `expiresAt > now()` independently of
   `status`), but any read path that trusts `status` alone (oikos's own admin
   credit-summary route does) shows stale, already-expired balances as if they were live.
   **This plan wires a real recurring sweep** (Phase 4, mirroring `sessions`' own
   `runSessionExpirySweepOnce`/`startSessionExpiryWorker` pattern, itself modeled on
   `agora/server/retention.ts` — see below) **and** makes every read path compute
   "active" from `remainingQuantity > 0 AND (expiresAt IS NULL OR expiresAt > now())`
   directly, never trusting `status` alone, so a lag between expiry and the next sweep
   tick never shows a stale balance either way — belt and suspenders, not one or the
   other.
2. **All oikos money/quantity math is `Number()` + floating point**, despite
   `numeric(12,2)` columns end-to-end, compounding across `CONVERT_BY_VALUE`'s multiple
   divide/multiply steps. This plan sidesteps the whole class of bug for the parts it
   builds: **lot quantities are whole minutes, stored as Postgres `integer`, never
   `numeric`/decimal strings** (see "Minutes are integers, not money" below) — there is
   no floating-point arithmetic to avoid because there is no fractional-minute
   arithmetic in this pass at all. The one place real money is involved (a purchase's
   `priceAmount`) is handed straight to `wallet`'s `debitWallet()`/`creditWallet()` as an
   opaque decimal string — this module never parses or computes on it itself.
3. **`CreditApplications.ledgerEntryId` is an unconstrained UUID (no real FK) in oikos**,
   explicitly commented as "left unconstrained to avoid circular dependencies." This
   plan's own schema has a similar circularity risk (a grant's originating purchase vs. a
   purchase's resulting grant) and resolves it with a real FK instead of dropping the
   constraint — see "Avoiding the circular FK" below.
4. **Several oikos enum values are defined but never produced** (`CASH_BONUS`/`HYBRID`
   product types, `PENDING` purchase/grant status, `FREE`/`MANUAL` application type,
   `REVERSED` ledger type) — evidence of a partially-built feature surface. This plan
   does not carry forward vocabulary nothing will produce; see Schema below for the
   trimmed status/type domains actually used.
5. **`maxPurchasesPerMember`/`maxPurchasesTotal` on oikos's `CreditProducts` are dead
   columns** — defined, never enforced anywhere in the service layer. Not ported.
6. **oikos's admin "Create/Edit Credit Product" web UI never actually saves** — the
   backend routes work; the web client (`lib/api/credit-client.ts`) is a stub that
   `throw`s "Not implemented" and the create/edit pages comment out the real call while
   still showing a success toast. This plan does not carry forward the illusion; Phase 5
   builds the product-management UI against the real routes from day one.

### Scope decision: session-billing integration is **out of scope** for this plan

This task explicitly asks for an unambiguous call, not a left-open ambiguity. The call:

**This plan builds the standalone credit-lot ledger — purchase, grant, manual consume,
adjust, void, expire, view — and exports a `consumeCredits()` helper shaped exactly like
`wallet`'s `debitWallet()` (already-open `tx` in, ready for a caller to compose into its
own transaction). It does not modify `sessions` or wire automatic consumption into
session billing in this pass.**

Reasoning:

1. **`sessions` is already committed (`6f10812`)** as a finished, accepted plan — its own
   "Critical scope finding" explicitly cut credit-fallback billing and its Open Question 1
   already flags this as a possible future reconsideration, not an oversight. Amending an
   already-committed sibling plan is a different unit of work than planning a new module,
   and doing it as a side effect here would violate this codebase's own scope discipline
   (`.ai/rules/implementation.md`'s "do not expand scope... because it seems adjacent" and
   `feature-planning.md`'s phase-boundary discipline) — the right shape for that work is
   its own reviewed amendment to the `sessions` plan, not a paragraph buried in this one.
2. **The two payment-selection models the task asked to weigh — "credits first, then
   cash" (oikos's actual behavior) vs. "staff's choice at session start" — have a real
   trade-off, and picking one is itself a design decision `sessions`' own reviewers should
   see explicitly, not inherit silently from this plan.** Below, "Recommended follow-up"
   states a concrete recommendation (staff-selectable, not automatic fallback) with
   reasoning, specified precisely enough to implement, but **not implemented here** — it's
   a proposal for the follow-up amendment to act on or override.
3. **This module is fully useful on its own without that wiring**: an admin can sell
   passes, a customer can hold and view them, staff can correct/void — the same "ledger
   first, consumer later" sequencing `wallet` itself used (`wallet` shipped its ledger +
   `debitWallet()` before `sessions` existed to call it; `sessions` then consumed it in
   its own phase). This plan puts `credits` in the identical position `wallet` was in
   before `sessions` landed, just after the fact instead of before.

#### Recommended follow-up (NOT built in this plan) — wiring `consumeCredits` into `sessions`

Specified precisely enough to implement as its own small amendment plan, once accepted:

- Add a nullable `billingMethod` column to `ChronoSessions`: `text("billingMethod")
  .notNull().default("wallet")`, values `"wallet" | "credits"`. Staff picks it in the
  **Start Session** dialog (a `Select`, defaulting to "Wallet" — every existing session
  keeps today's behavior with zero migration-time backfill needed beyond the column
  default).
- **Recommendation: staff-selectable payment method, not oikos's automatic
  wallet-then-credit-fallback.** Reasoning: oikos's fallback drains wallet cash first,
  then walks eligible credit lots for any shortfall — a real, working feature, but it
  turns a session close into a mutation across **two** independent balance systems that
  must succeed-or-fail together, which materially complicates the atomic-claim `closeSession`
  `sessions`' own plan already proved race-safe as a single-ledger operation (`wallet`
  only). A staff-selected method keeps `closeSession` a single-ledger charge — either it
  calls `debitWallet` (today's shipped behavior, unchanged) or it calls `consumeCredits`
  (new branch) — never both in the same close. This is a recommendation for the follow-up
  plan's own reviewers to accept or override, not a decision made here.
- Concretely: `closeSession`'s existing `if (Number(amountCharged) > 0) { await
  debitWallet(...) }` block would gain a sibling branch — `else if (claimed.billingMethod
  === "credits") { await consumeCredits(tx, { tenantId, memberId: claimed.memberId,
  quantityMinutes: Math.ceil(billableSeconds / 60), stationGroupId: station.stationGroupId,
  reason: \`Session ${claimed.id}\`, referenceType: "session", referenceId: claimed.id,
  performedByUserId }) }` — the shortfall-reporting shape (`consumed`/`shortfall` on the
  return value, see "Consumption algorithm" below) plugs into the exact same
  cap-and-record pattern `sessions` already uses for a wallet shortfall, just against a
  minutes ceiling instead of a money ceiling.
- This is a **new, separate plan/phase** amending the already-committed `sessions` plan
  (its own Phase 3 service file) — out of scope for this `credits` plan to execute.

### Minutes are integers, not money

Every quantity in this module (`ChronoCreditProducts.quantityMinutes`,
`ChronoCreditGrants.originalQuantity`/`remainingQuantity`,
`ChronoCreditGrantLedgerEntries.quantityDelta`/`Before`/`After`) is a Postgres
`integer` — whole minutes — not `numeric`. This is a deliberate, explained improvement
over oikos (which used `numeric(12,2)` even for whole-minute counts and then computed
against them in floating point anyway, see "Known oikos weaknesses" above): a minute
count has no fractional-cent-style precision concern, so there is no decimal-safety
ceremony to build for it. The one column that genuinely is money —
`ChronoCreditProducts.priceAmount` / `ChronoCreditPurchases.priceAmount` — stays
`numeric(12,2)` and is handed to `wallet`'s own money-safe helpers untouched; this module
never parses or arithmetics on it.

### Deliberately narrowed from oikos (beyond the session-billing cut above)

- **No `CONVERT_BY_VALUE` credit policy.** oikos's cross-tier value-conversion (spend a
  Gold lot's minutes at a Silver station by converting through each tier's hourly rate)
  is real, working oikos code, but it's the one genuinely complex piece of the
  consumption algorithm and — with no session integration in this pass — nothing
  actually resolves a "target station group" to convert against yet (see Scope decision
  above). This plan ships the two simpler, immediately-useful policies —
  `strict_group_only` (must match) and `any_station` (always eligible) — and reserves
  `convert_by_value` as a documented, not-yet-implemented value: the schema keeps every
  column `CONVERT_BY_VALUE` math would need (`sourceRatePerHourSnapshot` is **not**
  added in this pass — deliberately, since nothing reads it yet — but `stationGroupId` +
  `creditPolicy` on the grant already carry enough to add it additively later without a
  breaking migration). **Open Question 2** flags this for confirmation.
- **No multi-rule product bundles.** oikos's `CreditProductGrantRules` lets one purchase
  fan out into several lots (e.g. "5 Regular hours + 2 VIP hours" from a single SKU).
  This plan flattens a product to **one grant definition** (quantity, unit,
  `stationGroupId`, `creditPolicy`, validity) — one purchase, one lot. **Open Question 3**
  flags this simplification for confirmation; a real bundle need later is a genuinely
  separate table (`ChronoCreditProductGrantRules`), not a schema change to
  `ChronoCreditProducts` itself, so this cut doesn't foreclose it.
- **No `UsageEvents`/`CreditApplications` tables.** Those exist in oikos purely to record
  *how a session tick was paid* (part wallet, part which grant) — with no session
  integration in this pass, there is nothing for them to record. They belong to the
  deferred `sessions` amendment above, not to this plan.
- **No product time-windows (`startsAt`/`endsAt`).** Mirrors `stations`' own "no
  `PricingRule` engine" cut — a product is either `draft`, `active` (sellable), or
  `archived`; no scheduled-availability window.
- **Void is unused-only, not pro-rated.** See "Void semantics" below.

### Void semantics

A grant can be voided at any time (admin+) — it zeroes `remainingQuantity` and marks
`status: "voided"`, a straightforward correction (e.g. "this was granted by mistake").
**Voiding the purchase that produced a lot is narrower**: it is only permitted while the
lot is **entirely unused** (`remainingQuantity === originalQuantity`) — otherwise **409**.
This is a deliberate simplification over inventing a pro-rated "refund the unused
portion" calculation nobody asked for; if a lot has been partially spent, the admin
action is to void the **grant** directly (forfeiting the remainder, no wallet refund) —
voiding the **purchase** is specifically "this sale should not have happened at all,"
which only makes sense before any of it was used. **Open Question 5** flags this for
confirmation.

### Schema — four tables, deliberately fewer than oikos's seven (see "Deliberately
narrowed" for the two it drops)

New file `apps/chrono-api/src/modules/credit/schema.ts`. Declared in dependency order —
**note the circular-FK avoidance**: `ChronoCreditGrants` does **not** carry a
`purchaseId` back-reference; only `ChronoCreditPurchases.grantId` points at the grant,
populated *after* the grant is inserted in the same transaction (see "Avoiding the
circular FK" below).

```ts
import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoStationGroup } from "../station/schema";
import { chronoWalletTransaction } from "../wallet/schema";

// ---- ChronoCreditProducts — the sellable pack definition -------------------

export const chronoCreditProduct = pgTable(
  "ChronoCreditProducts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    // "draft" | "active" | "archived" — free-text, not a pg enum, matching
    // every prior Chrono plan's convention (see branches' own precedent).
    status: text("status").notNull().default("draft"),
    // Reserved for future PHP/POINT support (oikos's CreditUnit); this pass's
    // Zod contract restricts it to "minute" only — see "Minutes are integers".
    unit: text("unit").notNull().default("minute"),
    quantityMinutes: integer("quantityMinutes").notNull(),
    priceAmount: numeric("priceAmount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("PHP"),
    // Null = spendable at any station (creditPolicy "any_station"). Required
    // when creditPolicy is "strict_group_only" — enforced at the Zod layer
    // (see Contracts), matching this codebase's existing convention of
    // cross-field invariants living in the route/service layer, not a DB
    // CHECK constraint (same choice `stations`' branch/code uniqueness and
    // `wallet`'s balance-non-negative invariant both made).
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    // "strict_group_only" | "any_station" — "convert_by_value" is reserved,
    // not yet implemented (see "Deliberately narrowed").
    creditPolicy: text("creditPolicy").notNull().default("any_station"),
    // Days after issue a lot from this product expires; null = never expires.
    validityDays: integer("validityDays"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_product_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_credit_product_tenant_code_idx").on(t.tenantId, t.code),
  ],
);

// ---- ChronoCreditGrants — the actual lot (the balance) ----------------------

export const chronoCreditGrant = pgTable(
  "ChronoCreditGrants",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // Null for a manual admin grant (no purchase). Set null (not restrict) if
    // the product is later archived — a lot outlives its product definition.
    productId: text("productId").references(() => chronoCreditProduct.id, {
      onDelete: "set null",
    }),
    // Copied from the product at issue time — a snapshot, immune to a later
    // product edit, matching sessions' own "rate frozen at start" precedent.
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    creditPolicy: text("creditPolicy").notNull().default("any_station"),
    unit: text("unit").notNull().default("minute"),
    originalQuantity: integer("originalQuantity").notNull(),
    remainingQuantity: integer("remainingQuantity").notNull(),
    // Lower = spent first among equally-eligible lots. Default matches
    // oikos's own default.
    priority: integer("priority").notNull().default(100),
    expiresAt: timestamp("expiresAt"),
    // "granted" | "depleted" | "expired" | "voided" — trimmed from oikos's
    // six-value enum; "pending"/"refunded" were never produced anywhere in
    // oikos's own service code (see "Known oikos weaknesses").
    status: text("status").notNull().default("granted"),
    // Populated only for a manual grant/adjustment — why this lot exists
    // outside a purchase.
    reason: text("reason"),
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_grant_tenant_idx").on(t.tenantId),
    index("chrono_credit_grant_member_idx").on(t.memberId),
    index("chrono_credit_grant_station_group_idx").on(t.stationGroupId),
    index("chrono_credit_grant_status_idx").on(t.status),
    index("chrono_credit_grant_expires_idx").on(t.expiresAt),
  ],
);

// ---- ChronoCreditPurchases — one row per sale -------------------------------

export const chronoCreditPurchase = pgTable(
  "ChronoCreditPurchases",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // restrict: a purchase record must always show what it bought — a
    // product is archived, never deleted, in this pass anyway (no DELETE
    // route on ChronoCreditProducts), so this is a defensive floor, not a
    // live concern.
    productId: text("productId")
      .notNull()
      .references(() => chronoCreditProduct.id, { onDelete: "restrict" }),
    // The lot this purchase produced. Populated at insert time — the grant
    // row is always created FIRST inside the same transaction, so this is
    // never circular (see "Avoiding the circular FK" below). set null rather
    // than restrict/cascade: the purchase record survives even if the grant
    // it produced is later hard-deleted by some future maintenance path
    // (none exists today — defensive only).
    grantId: text("grantId").references(() => chronoCreditGrant.id, {
      onDelete: "set null",
    }),
    // Snapshots — immutable even if the product is edited afterward.
    quantityMinutes: integer("quantityMinutes").notNull(),
    priceAmount: numeric("priceAmount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("PHP"),
    // "completed" | "voided" — trimmed from oikos's five-value enum; this
    // pass has no PENDING/PAID intermediate state (a sale completes
    // atomically with its wallet debit, matching wallet's own "no retried-
    // external-request problem yet" reasoning for skipping an idempotency
    // key — there is no async payment step here to be pending about).
    status: text("status").notNull().default("completed"),
    walletTransactionId: text("walletTransactionId").references(
      () => chronoWalletTransaction.id,
      { onDelete: "set null" },
    ),
    voidedAt: timestamp("voidedAt"),
    voidedByUserId: text("voidedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_purchase_tenant_idx").on(t.tenantId),
    index("chrono_credit_purchase_member_idx").on(t.memberId),
    index("chrono_credit_purchase_product_idx").on(t.productId),
    index("chrono_credit_purchase_status_idx").on(t.status),
  ],
);

// ---- ChronoCreditGrantLedgerEntries — immutable audit trail -----------------

export const chronoCreditGrantLedgerEntry = pgTable(
  "ChronoCreditGrantLedgerEntries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    grantId: text("grantId")
      .notNull()
      .references(() => chronoCreditGrant.id, { onDelete: "cascade" }),
    // Denormalized alongside grantId (mirrors wallet's own
    // ChronoWalletTransactions.memberId denormalization) so a member's own
    // ledger reads without a join through every grant.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // "granted" | "consumed" | "expired" | "voided" | "adjusted" — trimmed
    // from oikos's seven-value enum; "reversed" was never produced anywhere
    // in oikos's own service code (see "Known oikos weaknesses").
    type: text("type").notNull(),
    // Signed: positive = balance increased (granted/restored), negative =
    // decreased (consumed/expired/voided/adjusted-down). This invariant —
    // quantityAfter = quantityBefore + quantityDelta, always — is what makes
    // the ledger self-checking, same principle wallet's own ledger uses.
    quantityDelta: integer("quantityDelta").notNull(),
    quantityBefore: integer("quantityBefore").notNull(),
    quantityAfter: integer("quantityAfter").notNull(),
    reason: text("reason"),
    // Free-text categorization of what caused this entry: "purchase" |
    // "manual" | "session" (future, unenforced today — the deferred
    // sessions amendment can start writing this value with zero migration).
    referenceType: text("referenceType"),
    referenceId: text("referenceId"),
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Immutable — no updatedAt, never updated after insert.
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_ledger_tenant_idx").on(t.tenantId),
    index("chrono_credit_ledger_grant_idx").on(t.grantId),
    index("chrono_credit_ledger_member_idx").on(t.memberId),
    index("chrono_credit_ledger_type_idx").on(t.type),
    index("chrono_credit_ledger_created_idx").on(t.createdAt),
  ],
);
```

#### Avoiding the circular FK

oikos's `CreditApplications.ledgerEntryId` is an unconstrained UUID with a comment
admitting it exists "to avoid circular dependencies" — a real FK dropped rather than
designed around. This plan's schema has the same latent shape (a grant produced *by* a
purchase, a purchase *producing* a grant) and resolves it properly instead: **only
`ChronoCreditPurchases.grantId` exists; `ChronoCreditGrants` has no `purchaseId`.**
`purchaseCreditProduct` (see below) always inserts the grant row first, then the purchase
row referencing it — never the reverse — so there is nothing circular to break. If a
grant's originating purchase is ever needed from the grant side, it's a one-row lookup
(`SELECT * FROM ChronoCreditPurchases WHERE grantId = :id`) or, for the ledger's own
purposes, already recorded on the `granted` ledger entry's
`referenceType: "purchase"`/`referenceId: <purchaseId>`.

### `APP_TENANT_TABLES`

Add `"ChronoCreditProducts"`, `"ChronoCreditGrants"`, `"ChronoCreditPurchases"`,
`"ChronoCreditGrantLedgerEntries"` to the array in `apps/chrono-api/src/db/schema.ts`
(check the file's current state first — as of this writing it only re-exports
`chronoBranch`/`chronoMemberProfile`; `station`/`wallet`/`session` haven't landed either,
so don't assume any of their entries already exist), and re-export all four tables from
the module into that file, mirroring the existing `chronoBranch`/`chronoMemberProfile`
re-export style exactly.

### Contracts — `apps/chrono-api/src/modules/credit/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const creditProductStatusSchema = z.enum(["draft", "active", "archived"]);
export const creditPolicySchema = z.enum(["strict_group_only", "any_station"]);
export const creditUnitSchema = z.enum(["minute"]); // reserved: more units later
export const creditGrantStatusSchema = z.enum([
  "granted",
  "depleted",
  "expired",
  "voided",
]);

const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

export const createCreditProductSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50),
    quantityMinutes: z.number().int().positive().max(100_000),
    priceAmount: moneyAmountSchema,
    stationGroupId: z.string().min(1).optional(),
    creditPolicy: creditPolicySchema.optional(), // defaults to "any_station"
    validityDays: z.number().int().positive().max(3650).optional(),
    unit: creditUnitSchema.optional(), // defaults to "minute"
  })
  .refine(
    (v) => v.creditPolicy !== "strict_group_only" || !!v.stationGroupId,
    { message: "A strict-group product must specify a stationGroupId.", path: ["stationGroupId"] },
  );

export const updateCreditProductSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    priceAmount: moneyAmountSchema.optional(),
    stationGroupId: z.string().min(1).optional(),
    creditPolicy: creditPolicySchema.optional(),
    validityDays: z.number().int().positive().max(3650).optional(),
    status: creditProductStatusSchema.optional(),
    // quantityMinutes/code/unit are immutable after creation — a running
    // product's promised quantity must not shift under existing purchasers'
    // expectations; a new SKU is a new product.
  })
  .refine(
    (v) => v.creditPolicy !== "strict_group_only" || !!v.stationGroupId,
    { message: "A strict-group product must specify a stationGroupId.", path: ["stationGroupId"] },
  );

export const purchaseCreditProductSchema = z.object({
  productId: z.string().min(1),
});

export const grantCreditsSchema = z.object({
  quantityMinutes: z.number().int().positive().max(100_000),
  stationGroupId: z.string().min(1).optional(),
  creditPolicy: creditPolicySchema.optional(), // defaults to "any_station"
  expiresAt: z.string().datetime().optional(),
  reason: z.string().min(1).max(255),
});

export const adjustCreditGrantSchema = z.object({
  deltaMinutes: z.number().int().positive().max(100_000), // amount subtracted
  reason: z.string().min(1).max(255),
});

export const consumeCreditsSchema = z.object({
  quantityMinutes: z.number().int().positive().max(1440),
  stationGroupId: z.string().min(1).optional(),
  reason: z.string().min(1).max(255),
});

export const creditProductListQuerySchema = listQuerySchema([
  "name",
  "code",
  "createdAt",
]).extend({
  status: creditProductStatusSchema.optional(),
});

export const creditGrantListQuerySchema = listQuerySchema([
  "createdAt",
  "expiresAt",
]).extend({
  status: creditGrantStatusSchema.optional(),
});

export const creditLedgerListQuerySchema = listQuerySchema(["createdAt"]);

export type CreateCreditProductInput = z.infer<typeof createCreditProductSchema>;
export type UpdateCreditProductInput = z.infer<typeof updateCreditProductSchema>;
export type PurchaseCreditProductInput = z.infer<typeof purchaseCreditProductSchema>;
export type GrantCreditsInput = z.infer<typeof grantCreditsSchema>;
export type AdjustCreditGrantInput = z.infer<typeof adjustCreditGrantSchema>;
export type ConsumeCreditsInput = z.infer<typeof consumeCreditsSchema>;
export type CreditProductStatus = z.infer<typeof creditProductStatusSchema>;
export type CreditPolicy = z.infer<typeof creditPolicySchema>;
export type CreditGrantStatus = z.infer<typeof creditGrantStatusSchema>;
```

No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
contracts stay local unless a second business app needs them.

### Consumption algorithm — `consumeCredits`

The single function that decides which lot(s) pay for a spend, ported from oikos's
deterministic scorer, trimmed to the two policies this pass supports:

```ts
// apps/chrono-api/src/modules/credit/service.ts

function scoreGrantEligibility(
  grant: { creditPolicy: string; stationGroupId: string | null },
  targetStationGroupId: string | null,
): number {
  if (grant.creditPolicy === "strict_group_only") {
    // Must match the session/consume's own station group exactly. No match
    // at all (targetStationGroupId is null, i.e. no station context) is also
    // ineligible — a strict-group lot needs a group to check against.
    return targetStationGroupId && grant.stationGroupId === targetStationGroupId ? 1 : 99;
  }
  // "any_station" — always eligible regardless of target.
  return 2;
}

async function applyGrantDelta(
  tx: TenantTx,
  grant: ChronoCreditGrantRow, // already locked by the caller
  args: {
    tenantId: string;
    delta: number; // signed minutes
    type: "granted" | "consumed" | "expired" | "voided" | "adjusted";
    reason?: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
) {
  const quantityAfter = grant.remainingQuantity + args.delta;
  if (quantityAfter < 0) {
    throw new HttpError(422, "Adjustment exceeds remaining balance.");
  }
  const nextStatus = quantityAfter === 0 && args.delta < 0
    ? (args.type === "voided" ? "voided" : args.type === "expired" ? "expired" : "depleted")
    : grant.status;
  const [updated] = await tx
    .update(chronoCreditGrant)
    .set({ remainingQuantity: quantityAfter, status: nextStatus, updatedAt: new Date() })
    .where(eq(chronoCreditGrant.id, grant.id))
    .returning();
  await tx.insert(chronoCreditGrantLedgerEntry).values({
    tenantId: args.tenantId,
    grantId: grant.id,
    memberId: grant.memberId,
    type: args.type,
    quantityDelta: args.delta,
    quantityBefore: grant.remainingQuantity,
    quantityAfter,
    reason: args.reason,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    performedByUserId: args.performedByUserId,
  });
  return updated!;
}

export async function consumeCredits(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    quantityMinutes: number;
    stationGroupId?: string | null;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
): Promise<{ consumed: number; shortfall: number; applications: Array<{ grantId: string; minutes: number }> }> {
  // Lock every candidate lot up front — active (unexpired, remaining > 0)
  // grants for this member, ordered for a stable eligibility pass.
  const candidates = await tx
    .select()
    .from(chronoCreditGrant)
    .where(
      and(
        eq(chronoCreditGrant.tenantId, args.tenantId),
        eq(chronoCreditGrant.memberId, args.memberId),
        eq(chronoCreditGrant.status, "granted"),
        gt(chronoCreditGrant.remainingQuantity, 0),
        or(isNull(chronoCreditGrant.expiresAt), gt(chronoCreditGrant.expiresAt, new Date())),
      ),
    )
    .for("update");

  const eligible = candidates
    .map((g) => ({ grant: g, score: scoreGrantEligibility(g, args.stationGroupId ?? null) }))
    .filter((c) => c.score < 99)
    .sort((a, b) =>
      a.score - b.score ||
      a.grant.priority - b.grant.priority ||
      // nulls (never-expiring) sort last — spend the soonest-expiring first
      (a.grant.expiresAt?.getTime() ?? Infinity) - (b.grant.expiresAt?.getTime() ?? Infinity) ||
      a.grant.createdAt.getTime() - b.grant.createdAt.getTime(),
    );

  let remaining = args.quantityMinutes;
  const applications: Array<{ grantId: string; minutes: number }> = [];
  for (const { grant } of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, grant.remainingQuantity);
    await applyGrantDelta(tx, grant, {
      tenantId: args.tenantId,
      delta: -take,
      type: "consumed",
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      performedByUserId: args.performedByUserId,
    });
    applications.push({ grantId: grant.id, minutes: take });
    remaining -= take;
  }

  return {
    consumed: args.quantityMinutes - remaining,
    shortfall: remaining,
    applications,
  };
}
```

A shortfall is **reported, not thrown** — matching `wallet`'s own partial-fill precedent
and giving a future `sessions` caller (see "Recommended follow-up" above) the same
cap-and-record shape it already uses for a wallet shortfall.

### Purchase, grant, adjust, void — the other exported functions

```ts
export async function purchaseCreditProduct(
  tx: TenantTx,
  args: { tenantId: string; memberId: string; productId: string; performedByUserId?: string },
) {
  const [product] = await tx
    .select()
    .from(chronoCreditProduct)
    .where(and(eq(chronoCreditProduct.id, args.productId), eq(chronoCreditProduct.tenantId, args.tenantId)));
  if (!product) throw new HttpError(404, "Credit product not found.");
  if (product.status !== "active") throw new HttpError(409, "This product is not available for sale.");

  // Cash side first — reuses wallet's own guard (422 on insufficient balance)
  // rather than re-deriving it.
  const { transaction } = await debitWallet(tx, {
    tenantId: args.tenantId,
    memberId: args.memberId,
    amount: product.priceAmount,
    reason: `Credit purchase: ${product.name}`,
    referenceType: "credit_purchase",
    performedByUserId: args.performedByUserId,
  });

  const expiresAt = product.validityDays
    ? new Date(Date.now() + product.validityDays * 86_400_000)
    : null;
  const [grant] = await tx
    .insert(chronoCreditGrant)
    .values({
      tenantId: args.tenantId,
      memberId: args.memberId,
      productId: product.id,
      stationGroupId: product.stationGroupId,
      creditPolicy: product.creditPolicy,
      unit: product.unit,
      originalQuantity: product.quantityMinutes,
      remainingQuantity: product.quantityMinutes,
      expiresAt,
      performedByUserId: args.performedByUserId,
    })
    .returning();
  await tx.insert(chronoCreditGrantLedgerEntry).values({
    tenantId: args.tenantId,
    grantId: grant!.id,
    memberId: args.memberId,
    type: "granted",
    quantityDelta: product.quantityMinutes,
    quantityBefore: 0,
    quantityAfter: product.quantityMinutes,
    referenceType: "purchase",
    performedByUserId: args.performedByUserId,
  });

  const [purchase] = await tx
    .insert(chronoCreditPurchase)
    .values({
      tenantId: args.tenantId,
      memberId: args.memberId,
      productId: product.id,
      grantId: grant!.id,
      quantityMinutes: product.quantityMinutes,
      priceAmount: product.priceAmount,
      currency: product.currency,
      walletTransactionId: transaction.id,
    })
    .returning();

  return { purchase: purchase!, grant: grant! };
}

// grantCreditsManually: same insert shape as the grant half of
// purchaseCreditProduct above, minus the wallet debit and the
// ChronoCreditPurchases row — productId null, reason required.

// adjustCreditGrant: SELECT ... FOR UPDATE the target grant, then
// applyGrantDelta(tx, grant, { delta: -args.deltaMinutes, type: "adjusted", ... }).

// voidCreditGrant: SELECT ... FOR UPDATE the target grant, then
// applyGrantDelta(tx, grant, { delta: -grant.remainingQuantity, type: "voided", ... }).

// voidCreditPurchase: SELECT ... FOR UPDATE the purchase, then its grant.
// 409 if grant.remainingQuantity !== grant.originalQuantity (see "Void
// semantics"). Otherwise: applyGrantDelta(..., { delta: -remaining, type:
// "voided" }), set purchase.status = "voided" + voidedAt/voidedByUserId, and
// creditWallet(tx, { amount: purchase.priceAmount, reason: "Credit purchase
// voided", referenceType: "credit_purchase_void", referenceId: purchase.id,
// performedByUserId }).
```

Every one of these takes an already-open `tx` and is called from a route inside its own
`withTenant(...)` transaction — never opens its own, per the shared pattern.

### Routes — two Hono factories, two audiences (mirrors `members`/`wallet`/`sessions`' shape)

**Staff-facing — `apps/chrono-api/src/modules/credit/routes.ts`, `creditRoutes()`**
(`TenantVars`, composed into `apps/chrono-api/src/routes/rpc.ts` via
`.route("/credits", creditRoutes())`):

- `GET /products` — `requirePermission(c.var.tenant.permissions, { credit: ["read"] })`.
  `zValidator("query", creditProductListQuerySchema)`, `withTenant`, `{ items, meta }`.
- `POST /products` — `credit:manageProducts`. Validates `createCreditProductSchema`.
  If `stationGroupId` provided, looks it up inside the same `withTenant` transaction
  first — 404 if it doesn't belong to the caller's tenant (the same closure discipline
  `stations`' own branch-ownership check established). 409 on `(tenantId, code)`
  conflict. `recordStaffAudit({ action: "chronoCredit.productCreated", ... })`.
- `PATCH /products/:id` — `credit:manageProducts`. 404 cross-tenant.
  `recordStaffAudit({ action: "chronoCredit.productUpdated", ... })`.
- `GET /members/:memberId/summary` — `credit:read`. Tenant-scoped `tenantMember`
  existence check first (closes the isolation hole `wallet`'s Pass 1 flagged — this plan
  applies it to every mutating **and this one read** route that takes a `memberId`, since
  a summary read is exactly the kind of endpoint that would otherwise silently 200 with
  an empty list for a foreign-tenant id instead of 404ing). Returns active grants (
  `remainingQuantity > 0 AND (expiresAt IS NULL OR expiresAt > now())`, computed live —
  never trusting `status` alone, see "Known oikos weaknesses") grouped with totals.
- `GET /members/:memberId/grants` — `credit:read`. Paginated, `zValidator("query",
  creditGrantListQuerySchema)`, all grants (not just active) for history/audit purposes.
- `GET /members/:memberId/ledger` — `credit:read`. Paginated ledger entries.
- `POST /members/:memberId/purchase` — `credit:sell`. Tenant-scoped member existence
  check first. Validates `purchaseCreditProductSchema`. Calls `purchaseCreditProduct`
  inside `withTenant`. `recordStaffAudit({ action: "chronoCredit.purchased", metadata: {
  productId, quantityMinutes, priceAmount } })`.
- `POST /members/:memberId/grant` — `credit:grant`. Tenant-scoped member existence
  check first. If `stationGroupId` provided, tenant-scoped ownership check (same as
  product create). Validates `grantCreditsSchema`. Calls `grantCreditsManually`.
  `recordStaffAudit({ action: "chronoCredit.granted", metadata: { quantityMinutes, reason } })`.
- `POST /members/:memberId/consume` — `credit:consume`. Tenant-scoped member existence
  check first. Validates `consumeCreditsSchema`. Calls `consumeCredits` — response
  includes `{ consumed, shortfall, applications }` so staff sees exactly which lot(s)
  were drawn from.  `recordStaffAudit({ action: "chronoCredit.consumed", metadata: {
  quantityMinutes, consumed, shortfall } })`.
- `POST /grants/:id/adjust` — `credit:adjust`. 404 cross-tenant. Validates
  `adjustCreditGrantSchema`. Calls `adjustCreditGrant` — 422 if it would go negative
  (`applyGrantDelta`'s own guard). `recordStaffAudit({ action: "chronoCredit.adjusted",
  metadata: { deltaMinutes, reason } })`.
- `POST /grants/:id/void` — `credit:adjust`. 404 cross-tenant. Calls `voidCreditGrant`.
  `recordStaffAudit({ action: "chronoCredit.grantVoided", ... })`.
- `GET /purchases` — `credit:read`. Paginated, optional `memberId` filter.
- `POST /purchases/:id/void` — `credit:adjust`. 404 cross-tenant. 409 if the grant is
  already partially spent (see "Void semantics"). Calls `voidCreditPurchase`.
  `recordStaffAudit({ action: "chronoCredit.purchaseVoided", ... })`.

**Customer-facing — `apps/chrono-api/src/modules/credit/portal-routes.ts`,
`creditPortalRoutes()`** (`MemberVars`, `memberMiddleware()`, mounted via `.route(
"/portal/credits", creditPortalRoutes())` in `apps/chrono-api/src/app.ts`, mirroring the
existing `/portal/wallet` and `/portal/sessions` mounts):

- `GET /balance` — the caller's own active grants + totals, same "computed live from
  `expiresAt`" rule as the staff summary route. Empty list, not an error, if none exist.
- `GET /ledger` — the caller's own paginated ledger history. Empty list if none.

### Permission vocabulary

```ts
// packages/agora/src/auth/permissions.ts
export const PERMISSION_STATEMENTS = {
  ...
  credit: ["read", "sell", "consume", "grant", "adjust", "manageProducts"],
} as const;
```

- `staffRole` — `credit: ["read", "sell", "consume"]`. `sell` and `consume` are routine
  counter operations (issue a pass, record a manual spend-down) — the same tier `wallet`
  placed `credit`/`debit` at for staff.
- `adminRole` — `credit: ["read", "sell", "consume", "grant", "adjust",
  "manageProducts"]`. `grant` (free minutes, no charge) and `adjust` (subtract/void
  corrections) sit above staff, mirroring `wallet`'s own `adjust` gate exactly.
  `manageProducts` (catalog/pricing/policy config) is admin+-only, matching `branches`'
  own precedent for tenant-configuration-shaped resources.
- `ownerRole` — inherits automatically.

**Open Question 1 (resolve before Phase 3) — the staff/admin split above is this plan's
own reasoned call, not a confirmed oikos precedent.** Unlike `wallet` (where oikos's own
`requireRole(['OWNER','STAFF'])` on `top-up`/`debit` gave direct evidence for a
staff-inclusive gate), the research behind this plan did not confirm oikos's exact role
gates on its `admin-product.router.ts`/`admin-purchase.router.ts` routes — only that they
exist and are admin-facing. This plan's split instead follows this codebase's own
established precedent (`wallet`'s staff/admin tiering, extended with a `manageProducts`
config tier matching `branches`') rather than an oikos fact this research didn't verify.
Confirm the split above is the intended one before Phase 3.

### Audit action naming

`chronoCredit.productCreated/.productUpdated/.purchased/.granted/.consumed/.adjusted/
.grantVoided/.purchaseVoided` — checked against every prefix already in use in this
codebase (`project.*`, `file.*`, `customer.*`/`member.*`, `branch.*`,
`chronoMemberProfile.*`, `chronoWallet.*`, `station.*`/`stationGroup.*`, `session.*`) —
no collision.

### Background expiry sweep — reuses `sessions`' own precedent, not a new pattern

Exactly mirrors `apps/chrono-api/src/modules/session/expiry.ts` (that plan's own
`runSessionExpirySweepOnce`/`startSessionExpiryWorker`, itself modeled on
`agora/server/retention.ts`'s recurring table-scan-sweep pattern) — this is the second
Chrono module needing "scan a table for rows matching a time condition, repeatedly,
forever," so it reuses the identical shape rather than inventing a third one:

```ts
// apps/chrono-api/src/modules/credit/expiry.ts
export async function runCreditExpirySweepOnce(): Promise<{ expired: number }> {
  const due = await withAdmin((tx) =>
    tx
      .select({ id: chronoCreditGrant.id, tenantId: chronoCreditGrant.tenantId })
      .from(chronoCreditGrant)
      .where(
        and(
          eq(chronoCreditGrant.status, "granted"),
          isNotNull(chronoCreditGrant.expiresAt),
          lt(chronoCreditGrant.expiresAt, new Date()),
        ),
      )
      .limit(200), // same batch cap sessions' own sweep uses
  );
  let expired = 0;
  for (const row of due) {
    await withTenant(row.tenantId, async (tx) => {
      const [grant] = await tx
        .select()
        .from(chronoCreditGrant)
        .where(eq(chronoCreditGrant.id, row.id))
        .for("update");
      // Re-check under the lock — a concurrent consume/void may have already
      // moved it since the admin-scoped scan above.
      if (grant && grant.status === "granted" && grant.expiresAt && grant.expiresAt < new Date()) {
        await applyGrantDelta(tx, grant, {
          tenantId: row.tenantId,
          delta: -grant.remainingQuantity,
          type: "expired",
        });
      }
    });
    expired++;
  }
  return { expired };
}

const CREDIT_EXPIRY_SWEEP_INTERVAL_MS =
  Number(process.env.CREDIT_EXPIRY_SWEEP_INTERVAL_MS) || 300_000; // 5 min — a
  // lot's expiry is far less time-sensitive than a live session, so this
  // sweep runs less often than sessions' own 60s cadence.

export function startCreditExpiryWorker(): () => void {
  const timer = setInterval(() => {
    runCreditExpirySweepOnce().catch((err) => {
      logger.error({ msg: "credit expiry sweep failed", error: String(err) });
    });
  }, CREDIT_EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

Wired into `apps/chrono-api/src/index.ts` alongside `startSessionExpiryWorker()` (once
that lands) and `startQueueWorker(...)`/`startRetentionWorker()`, with a matching
`stopCreditExpiryWorker()` call in the `SIGINT`/`SIGTERM` handler.

### Web UI

- **Staff — `apps/chrono-web/src/app/dashboard/credits/page.tsx` (new)**: `Tabs`
  (`agora/ui`) split into **Members** (default — `useListQuery()`, member search →
  detail view showing active lots as `Badge`-scoped cards + a **Sell** / **Grant** /
  **Consume** action set, mirroring `wallet`'s own per-member detail pattern) and
  **Products** (a `DataTable`/`DataTableToolbar`/`DataTablePagination` list, a create/edit
  `Dialog`: name, code, quantityMinutes, priceAmount, stationGroupId `Select` (options
  from `GET /rpc/stations/groups`, "Any station" as the cleared/default state),
  creditPolicy `Select` (Strict Group Only / Any Station), validityDays, status `Select`
  (Draft/Active/Archived) — `agora/ui` primitives only). A per-member **Ledger** view
  (`DataTable`, columns: type `Badge`, quantity delta, balance after, reason, performed
  by, date), same shape `wallet`'s transaction history view uses.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Credits` entry to `BASE_NAV`
  (a `Ticket`/`Clock`-style `lucide-react` icon) and `"/dashboard/credits": "Credits"` to
  `TITLES`, mirroring the `Wallets`/`Sessions` entries (insertion point depends on
  whichever of those has landed by the time this phase runs — insert alongside them,
  same caveat every prior module's own Phase 4/5 already noted).
- **Customer — extend `apps/chrono-web/src/app/portal/page.tsx` further** (already
  extended by `members`/`wallet`/`sessions`): add a "Credits" `Card` listing active lots
  (remaining minutes, station-group scope badge if any, expiry) + a compact recent-ledger
  list. New small client helper `apps/chrono-web/src/lib/credits-portal.ts`
  (`getMyCreditBalance()`, `getMyCreditLedger(query)`), mirroring `wallet-portal.ts`'s
  shape exactly.
- `toast.success`/`toast.error` on every staff mutation, surfacing the 422/409 messages
  verbatim, matching every prior module's inline-message convention.

### CRUD & Feedback Contract

| Entity | Action | Method | Permission | Notes |
|---|---|---|---|---|
| Product | List | `GET /rpc/credits/products` | `credit:read` | paginated |
| Product | Create | `POST /rpc/credits/products` | `credit:manageProducts` | 409 on duplicate `(tenantId, code)`; 400 if `strict_group_only` with no `stationGroupId` |
| Product | Update | `PATCH /rpc/credits/products/:id` | `credit:manageProducts` | 404 cross-tenant; quantity/code/unit immutable |
| Member | Summary | `GET /rpc/credits/members/:memberId/summary` | `credit:read` | active lots computed live from `expiresAt`, not `status` alone |
| Member | Grants (history) | `GET /rpc/credits/members/:memberId/grants` | `credit:read` | paginated, all statuses |
| Member | Ledger | `GET /rpc/credits/members/:memberId/ledger` | `credit:read` | paginated |
| Member | Purchase (sell) | `POST /rpc/credits/members/:memberId/purchase` | `credit:sell` | 409 if product not active; 422 if wallet insufficient |
| Member | Grant (comp) | `POST /rpc/credits/members/:memberId/grant` | `credit:grant` | no charge, mandatory reason |
| Member | Consume | `POST /rpc/credits/members/:memberId/consume` | `credit:consume` | partial-fill; response reports `shortfall` |
| Grant | Adjust | `POST /rpc/credits/grants/:id/adjust` | `credit:adjust` | 422 if it would go negative |
| Grant | Void | `POST /rpc/credits/grants/:id/void` | `credit:adjust` | zeroes remaining, no refund |
| Purchases | List | `GET /rpc/credits/purchases` | `credit:read` | paginated, optional member filter |
| Purchase | Void | `POST /rpc/credits/purchases/:id/void` | `credit:adjust` | 409 if grant already partially used; refunds wallet in full |
| Balance (customer) | `GET /portal/credits/balance` | member session | empty list if none |
| History (customer) | `GET /portal/credits/ledger` | member session | empty list if none |
| Delete | — | — | not built this pass — a product is archived (status flip), a grant is voided, never hard-deleted; historical rows are permanent |

Feedback: `toast.success`/`toast.error` at the point of the API call, matching
`wallet`/`sessions`' own inline-message convention.

Audit linkage: `recordStaffAudit` on every staff mutation, each entry's `metadata`
carrying the quantity/amount involved, not just the action name.

### Out of Scope (this plan)

- **Wiring `consumeCredits` into `sessions`' billing close.** See "Scope decision" above
  — a fully specified but unbuilt recommendation for a separate follow-up amendment to
  the already-committed `sessions` plan.
- **`convert_by_value` credit policy** (cross-tier value conversion). Reserved in the
  schema's domain, not implemented — see "Deliberately narrowed" + Open Question 2.
- **Multi-rule product bundles** (`ChronoCreditProductGrantRules`-equivalent — one
  purchase yielding several lots across different station groups). A product is one
  grant definition in this pass — see "Deliberately narrowed" + Open Question 3.
- **`UsageEvents`/`CreditApplications`-equivalent tables.** Exist only to record
  session-tick billing, which this plan doesn't wire up — belongs to the deferred
  `sessions` amendment.
- **PHP/POINT credit units, loyalty points.** `unit` is reserved but restricted to
  `"minute"` at the contract layer. Loyalty points are a wholly separate, already-deferred
  system per `wallet`'s own research (`.ai/handover/chrono-migration.md`'s deferred list).
- **Self-service portal purchase.** Same payment-gateway deferral `wallet` made — no
  direct-purchase rail exists yet; a purchase is always staff-sold and wallet-funded.
- **Pro-rated purchase-void refunds.** Void is unused-only — see "Void semantics" +
  Open Question 5.
- **Product time-windows / scheduled availability** (`startsAt`/`endsAt`). Mirrors
  `stations`' own "no `PricingRule` engine" cut.
- **The `/rpc-admin` platform-admin cross-tenant view.** No
  `PLATFORM_PERMISSION_STATEMENTS` resource exists for this today, same reasoning as
  every prior module.
- **A `chronoCredit.*` webhook event.** Trivial follow-up, not required to ship, same
  deferral every prior module made.
- **A DB `CHECK` constraint for the `strict_group_only` ⇒ `stationGroupId` invariant.**
  Enforced at the Zod/route layer instead, matching this codebase's existing convention
  (see schema comment).

---

## Open Questions summary (confirm before/during Phase 3)

1. **Staff/admin permission split** (`sell`/`consume` staff-level, `grant`/`adjust`/
   `manageProducts` admin+) is this plan's own reasoned call, not a confirmed oikos
   precedent — see "Permission vocabulary."
2. **`convert_by_value` deferred entirely** — confirm the two-policy (`strict_group_only`/
   `any_station`) scope is acceptable for Wave 1, or that a richer cross-tier conversion
   is wanted now instead.
3. **Product bundles flattened to 1:1** (one product = one grant definition, no
   `CreditProductGrantRules`-equivalent fan-out) — confirm acceptable.
4. **Session-billing integration deferred entirely, with a specified-but-unbuilt
   recommendation** (staff-selectable `billingMethod` on `ChronoSessions`, not oikos's
   automatic wallet-then-credit fallback) for whoever picks up that follow-up amendment
   to the already-committed `sessions` plan — confirm this direction before that amendment
   is written.
5. **Purchase void is unused-only, no pro-rated refund** — confirm acceptable, or that a
   partial refund calculation is wanted instead.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/credit/schema.ts` (new) — all four tables (Pass 2),
  importing `chronoStationGroup` from `../station/schema` and `chronoWalletTransaction`
  from `../wallet/schema` (both must exist on disk by the time this phase runs — a real
  ordering dependency, same caveat `sessions`' own Phase 1 flagged for its imports).
- `apps/chrono-api/src/db/schema.ts` — import + re-export all four, add
  `"ChronoCreditProducts"`, `"ChronoCreditGrants"`, `"ChronoCreditPurchases"`,
  `"ChronoCreditGrantLedgerEntries"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/credit/` and write `schema.ts` exactly as
   specified in Pass 2 — tables declared in dependency order (`chronoCreditProduct` →
   `chronoCreditGrant` → `chronoCreditPurchase` → `chronoCreditGrantLedgerEntry`), no
   `purchaseId` column on `chronoCreditGrant` (see "Avoiding the circular FK").
2. In `apps/chrono-api/src/db/schema.ts`, add the import/re-export and append all four
   names to `APP_TENANT_TABLES` (check the file's current state first — don't clobber a
   concurrently-landed `station`/`wallet`/`session` entry).
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_credits` (never
   `db:push`). Review the generated SQL: expect four `CREATE TABLE` statements plus their
   indexes and FKs (including `chronoStationGroup`/`chronoWalletTransaction` references —
   confirm the migration fails cleanly at `db:migrate` time, not silently, if `stations`/
   `wallet`'s own migrations haven't landed yet), no destructive statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- All four tables exist with `FORCE ROW LEVEL SECURITY` on.
- All four names are present in `APP_TENANT_TABLES`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, service, routes, sweep, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/credit/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/credit/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write every schema/type specified in Pass 2's Contracts section exactly.
2. No `money.ts` needed in this module (unlike `wallet`/`session`) — minutes are plain
   integers and the one money field (`priceAmount`) is handed to `wallet`'s own helpers
   untouched; see "Minutes are integers, not money."
3. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- All listed types compile and are importable from `../modules/credit/contracts`.
- `createCreditProductSchema` rejects `{ creditPolicy: "strict_group_only" }` with no
  `stationGroupId`, and accepts it with one.
- `updateCreditProductSchema` accepts a single-field payload and rejects
  `quantityMinutes`/`code`/`unit` (not present in its shape at all — immutable fields).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** service, routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/credit/contracts.ts`.

---

## Phase 3 — Service (locking/consumption) + routes + permission gates + concurrency proof

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `credit: ["read", "sell", "consume",
  "grant", "adjust", "manageProducts"]` to `PERMISSION_STATEMENTS`, `staffRole` (`read`/
  `sell`/`consume` only), and `adminRole` (all six) — resolve Open Question 1 first
  (Pass 2).
- `apps/chrono-api/src/modules/credit/service.ts` (new) — `scoreGrantEligibility`,
  `applyGrantDelta`, `consumeCredits`, `purchaseCreditProduct`, `grantCreditsManually`,
  `adjustCreditGrant`, `voidCreditGrant`, `voidCreditPurchase` (Pass 2).
- `apps/chrono-api/src/modules/credit/routes.ts` (new) — `creditRoutes()` factory
  (`TenantVars`).
- `apps/chrono-api/src/modules/credit/portal-routes.ts` (new) — `creditPortalRoutes()`
  factory (`MemberVars`, `memberMiddleware()`).
- `apps/chrono-api/src/modules/credit/concurrency.test.ts` (new) — standalone `tsx`
  script, mirroring `wallet`/`session`'s own `concurrency.test.ts` structure and their
  "real Postgres, not pglite" requirement.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/credits", creditRoutes())`.
- `apps/chrono-api/src/app.ts` — `.route("/portal/credits", creditPortalRoutes())`.
- `apps/chrono-api/package.json` — add `"test:credit-concurrency": "tsx
  src/modules/credit/concurrency.test.ts"`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `credit` gate cases (staff denied
  `grant`/`adjust`/`manageProducts`, allowed `read`/`sell`/`consume`; admin/owner allowed
  all six).

**Step-by-step tasks**

1. Resolve Open Question 1, then edit `permissions.ts` per Pass 2's exact statement/role
   composition.
2. Write `service.ts`: `scoreGrantEligibility`, `applyGrantDelta`, `consumeCredits`
   exactly as specified in Pass 2 (row lock via `.for("update")` on every candidate grant,
   deterministic eligibility/priority/expiry/createdAt sort, partial-fill with a reported
   `shortfall`, never a thrown error for a shortfall itself — only for an `adjust` that
   would drive a single grant negative). `purchaseCreditProduct` (grant-then-purchase
   insert order, `debitWallet` composition), `grantCreditsManually`, `adjustCreditGrant`,
   `voidCreditGrant`, `voidCreditPurchase` (409 guard on partial use, `creditWallet`
   refund) — **all functions take an already-open `tx: TenantTx`**, never open their own
   transaction.
3. Write `routes.ts`: every mutating route (and the member-summary/grants/ledger GETs)
   first looks up `SELECT id FROM tenantMember WHERE id = :memberId` **inside the same
   `withTenant` call** — 404 if not found, before any credit read/write (closes the
   isolation hole from Pass 1/2, applied to every `memberId`-taking route, not just
   mutations). A `stationGroupId` in a product-create/grant payload gets the same
   tenant-scoped lookup-before-use `stations`' own branch-ownership check established.
   Follow the exact structure of the `/wallets`/`/sessions` blocks in
   `apps/chrono-api/src/routes/rpc.ts` (import style, `HttpError`, pagination meta shape).
4. Write `portal-routes.ts`: `GET /balance` (live-computed active lots, empty list if
   none), `GET /ledger` (paginated, empty if none).
5. Compose into `apps/chrono-api/src/routes/rpc.ts` and `apps/chrono-api/src/app.ts`,
   mirroring `wallet`'s own `/portal/wallet` mount.
6. Write `concurrency.test.ts`: seed one tenant + `tenantMember` + wallet (funded) + two
   or three `ChronoCreditGrants` rows directly (different `priority`/`expiresAt` values,
   at least one `strict_group_only` scoped to a seeded station group and one
   `any_station`), then fire **N concurrent** `consumeCredits` calls against a **real
   Postgres** connection (`DATABASE_URL_ADMIN`, not `DB_DRIVER=pglite` — same requirement
   `wallet`/`session`'s own concurrency tests state, for the same reason) and assert: (a)
   the sum of every grant's `remainingQuantity` decrease equals the total minutes
   actually consumed across all N calls, with no lost update; (b) the count of
   `ChronoCreditGrantLedgerEntries` rows equals exactly the number of individual grant
   applications made (no dropped/duplicated ledger rows); (c) replaying each grant's own
   ledger entries in `createdAt` order reconstructs that grant's final
   `remainingQuantity` (the self-checking invariant, same shape `wallet`'s own test
   proves). Also seed a separate scenario proving `purchaseCreditProduct`'s atomicity: an
   insufficient wallet balance must leave **no** `ChronoCreditGrants` row behind (the
   whole transaction rolls back, not just the wallet debit).
7. Add `credit` cases to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { credit: ["sell"] }) === true`,
   `hasPermission("staff", { credit: ["consume"] }) === true`,
   `hasPermission("staff", { credit: ["grant"] }) === false`,
   `hasPermission("staff", { credit: ["adjust"] }) === false`,
   `hasPermission("staff", { credit: ["manageProducts"] }) === false`,
   `hasPermission("admin", { credit: ["manageProducts"] }) === true`,
   `hasPermission("owner", { credit: ["adjust"] }) === true`.

**Acceptance criteria**

- `POST /rpc/credits/products` as staff → 403; as admin/owner → 201.
- `POST /rpc/credits/members/:memberId/purchase` on a `draft`/`archived` product → 409;
  on an `active` product with insufficient wallet balance → 422, and no
  `ChronoCreditGrants` row is created.
- `POST /rpc/credits/members/:memberId/consume` against a `strict_group_only` lot scoped
  to a different station group than the one requested → the lot is skipped (score 99),
  and if no other eligible lot exists, the response reports the full amount as
  `shortfall`, not an error.
- `POST /rpc/credits/grants/:id/adjust` beyond `remainingQuantity` → 422.
- `POST /rpc/credits/purchases/:id/void` on a partially-consumed purchase → 409; on an
  untouched one → 200, wallet is credited back the full `priceAmount`.
- Any mutating route with another tenant's `memberId`/`grantId`/`purchaseId`/
  `stationGroupId` → 404.
- `pnpm --filter @agora/chrono-api test:credit-concurrency` passes.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `credit` cases.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:credit-concurrency`

**Out of scope:** the expiry sweep (Phase 4), UI, e2e browser spec (Phase 6).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (the
route files reference the new resource, so the vocabulary must exist before either
typechecks).

---

## Phase 4 — Expiry sweep

**Files to update**

- `apps/chrono-api/src/modules/credit/expiry.ts` (new) — `runCreditExpirySweepOnce` /
  `startCreditExpiryWorker` (Pass 2).
- `apps/chrono-api/src/index.ts` — wire `startCreditExpiryWorker()` +
  `stopCreditExpiryWorker()` alongside the existing worker-startup/shutdown calls.

**Step-by-step tasks**

1. Write `expiry.ts` exactly as specified in Pass 2: `withAdmin`-scoped scan for due
   grants (`status: "granted"`, `expiresAt` in the past, batch-capped), then per-row
   `withTenant` + `SELECT ... FOR UPDATE` re-check-under-lock before expiring via
   `applyGrantDelta`.
2. Wire the worker into `apps/chrono-api/src/index.ts`'s existing startup/shutdown
   sequence (alongside `startQueueWorker`/`startRetentionWorker`/`startSessionExpiryWorker`
   once that lands), `.env.example` entry for `CREDIT_EXPIRY_SWEEP_INTERVAL_MS` (optional,
   defaults to 5 minutes).

**Acceptance criteria**

- A grant with `expiresAt` in the past and `status: "granted"` is flipped to `"expired"`,
  `remainingQuantity: 0`, with an `expired` ledger entry, within one sweep interval of a
  manual `runCreditExpirySweepOnce()` call in a test.
- A grant already consumed/voided before its `expiresAt` passes is left untouched by the
  sweep (the re-check-under-lock catches the race).
- `GET /rpc/credits/members/:memberId/summary` never lists an expired-but-not-yet-swept
  grant as active (the live `expiresAt` filter in the read path, independent of the
  sweep's own timing).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- A standalone script/test invoking `runCreditExpirySweepOnce()` directly against a
  seeded expired grant (mirrors how `sessions`' own sweep is expected to be exercised).

**Out of scope:** UI, e2e browser spec.

**Execution start point:** create `apps/chrono-api/src/modules/credit/expiry.ts`.

---

## Phase 5 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/credits/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `apps/chrono-web/src/app/portal/page.tsx` — extend with a Credits card.
- `apps/chrono-web/src/lib/credits-portal.ts` (new) — thin client wrapper for
  `GET /portal/credits/*`.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected; `Dialog`/`Select`/`Tabs`/`Input`/`Label`/`Badge` already exist).

**Step-by-step tasks**

1. Build `dashboard/credits/page.tsx` per Pass 2's Web UI section: **Members** tab
   (search → detail with active-lot cards, Sell/Grant/Consume dialogs, a Ledger view) and
   **Products** tab (`DataTable` + create/edit `Dialog`).
2. Add `{ type: "item", name: "Credits", href: "/credits", icon: <Ticket> }` to
   `BASE_NAV`, and `"/dashboard/credits": "Credits"` to `TITLES`, in
   `apps/chrono-web/src/app/dashboard/layout.tsx`.
3. Write `apps/chrono-web/src/lib/credits-portal.ts`: `getMyCreditBalance()`,
   `getMyCreditLedger(query)`.
4. Extend `apps/chrono-web/src/app/portal/page.tsx`: add a "Credits" `Card` next to the
   existing Wallet/Membership/Session cards.
5. Wire `toast.success`/`toast.error` on every staff mutation, surfacing 409/422
   messages verbatim.

**Acceptance criteria**

- `/dashboard/credits` renders both tabs; Products list is paginated/searchable; the
  Members tab's Sell/Grant/Consume dialogs submit successfully and the active-lots view
  refreshes.
- A staff-role session sees Sell/Consume but not Grant, and gets a toast error attempting
  Products create (server 403 surfaces client-side).
- `/portal` shows the current customer's active lots and recent ledger.
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 6).

**Execution start point:** create `apps/chrono-web/src/app/dashboard/credits/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/credits/credits.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring `apps/chrono-web/e2e/tests/data-listing/
   projects-listing.spec.ts`'s structure and `signUp()` helper, covering three cases per
   `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant (staff) + a customer; as admin, create a station
     (reuse `stations`' own e2e helper if landed) and a station group, create an
     `any_station` product and a `strict_group_only` product scoped to that group,
     activate both; top up the customer's wallet (reuse `wallet`'s helper); as staff,
     sell the `any_station` product to the customer, confirm the lot appears with the
     right remaining minutes; as admin, grant a free 30-minute comp with a reason,
     confirm it appears as a separate lot; as staff, consume 10 minutes and confirm the
     response + updated balance reflect the correct lot(s) drawn from (the eligibility
     order); as the customer, reload `/portal` and confirm the lots/ledger match what
     staff recorded.
   - **Role gate**: staff can Sell/Consume but a Products-create attempt and a Grant
     attempt both surface a 403-driven toast; admin/owner can do both.
   - **Tenant isolation**: tenant A sells a pass to its customer; tenant B's Credits
     view never shows that member/lot, and a direct cross-tenant `memberId`/`grantId`
     mutation attempt 404s (drive via the API client in the spec, matching `wallet`'s own
     spec's approach for this case).
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for slugs/emails/names/
   product codes, per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config, per `.ai/rules/rbac.md`'s "Testing" section).
- No `.env` present in `apps/chrono-api` while running.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/credits/credits.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage; any `sessions`-integration coverage (that
wiring is out of scope for this plan entirely — see "Scope decision").

**Execution start point:** create `apps/chrono-web/e2e/tests/credits/credits.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/credits/` to
`.ai/plans/chrono/archive/credits/` once all six phases are verified and committed
separately. Update `.ai/handover/chrono-migration.md`'s status table (add a `credits` row:
`done, committed (<hash>)`) and its "Newly discovered during planning" note (currently
flagging `credits` as deferred-and-unscoped — update it to point at this plan instead of
describing it as still-unplanned). If the developer wants the "Recommended follow-up"
(wiring `consumeCredits` into `sessions`) picked up, that's a new, separate plan amending
the already-committed `sessions` plan — not a phase of this one.
