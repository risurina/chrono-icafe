# Chrono — `vouchers` module

**Depends on:** `members` (implemented, `tenantMember` anchor) and `pos` for its actual
purpose — redemption at checkout. **`pos` today has only `schema.ts` + `contracts.ts` —
no `service.ts`/`routes.ts`.** There is no live checkout endpoint to redeem a voucher
against yet. This plan ships the standalone voucher store (issue/list/cancel, its own
schema/contracts/permissions) now, because it stands on its own and needs nothing from
`pos` to exist, and gates only the actual "redeem this code and discount this sale" wiring
on `pos`'s own checkout route landing — see Phase 4.

## What this is

A single-use redeemable code — either issued directly to a specific customer (a gift/
comp voucher) or handed out as part of a `promos` campaign (see the sibling `promos`
plan) — that a cashier applies at POS checkout to discount a sale. This module owns the
voucher *instance* (its code, its value, its status); `promos` owns the *campaign* that
can optionally mint vouchers in bulk. The two are related but independently useful:
staff can issue a one-off ₱200 voucher to a customer with no promo behind it at all.

## Prior art and where this plan diverges from it

Read at `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/database/schema/promos.ts`
(`Voucher` table) + `src/modules/vouchers/{service,routes,dto}.ts`, and cross-checked
against `src/modules/pos/{routes,dto}.ts` for any actual checkout wiring.

**The single most important finding: oikos's `Voucher` table is a dead island. It is
never consulted by checkout at all.** `pos/routes.ts` has a line type literally named
`'PROMO_PACKAGE'`, which looks like it should be this — it is not. Tracing it
(`promoProductMap`/`promoRulesByProductId`, sourced from `CreditProducts`/
`CreditProductGrantRules`) shows `PROMO_PACKAGE` is oikos's name for a **credit-package
purchase line** (buy X, get Y credits granted) — completely unrelated to the `Promo`/
`Voucher` tables. Grepping oikos's entire `pos` module for `Voucher`/`voucher` (case-
insensitive) returns zero hits. So in oikos today: you can create a promo, issue a
voucher against it, and call `redeemVoucher` to flip its status to `REDEEMED` — but
nothing anywhere ever uses that flip to change what a customer pays. The feature this
task actually asks for ("vouchers... redeemable at POS checkout") **does not exist in
oikos** — it's prior art for the data shape only, not for the integration, which is new
design work in this plan, not a port.

Given that, this plan does not try to preserve oikos's redemption flow as-is; it
rebuilds it as a real checkout-time mechanism, fixing several structural gaps oikos's
standalone CRUD never had to face because nothing actually consumed it:

1. **No traceability of what a voucher was redeemed against.** oikos's `redeemVoucher`
   sets `status: 'REDEEMED'`/`redeemedAt` and nothing else — there's no way to answer
   "which sale used this voucher," which matters the moment a sale is refunded (should
   the voucher un-redeem?). This plan adds `redeemedAgainstSaleId` (a real FK to
   `chronoSale`, which already exists on disk), so a refund can look up and reverse the
   exact voucher it consumed (Phase 4).
2. **`value`-and-`type` double duty with no separate discount kind.** oikos's `Promo`
   (which a `Voucher` optionally points at) has a single `value` column serving double
   duty depending on `type: 'DISCOUNT' | 'FREE_CREDIT'` — a percentage-off voucher and a
   flat-amount-off voucher are indistinguishable in the schema. This plan splits
   `discountType` (`"percentage" | "fixed_amount"`) from `discountValue`, with a
   percentage capped `0 < v <= 100` at the contract layer — an actual constraint, not an
   implicit convention nobody enforces.
3. **A voucher with no discount data at all is representable** — oikos's `Voucher` has
   no discount fields of its own; a voucher's value only exists via its optional
   `promoId` FK, so a "generic gift voucher with no promo behind it" (a real thing this
   task explicitly asks for — "gift vouchers") **cannot even be modeled** in oikos's
   schema. This plan stores `discountType`/`discountValue` directly on the voucher row,
   with `promoId` staying optional/nullable metadata about provenance, not the only
   place the value lives.
4. **No concurrency discipline at redemption.** A bare `UPDATE` with a `WHERE status =
   ...`-less clause (the status check happens in application code, after the read, with
   no row lock) is the same TOCTOU shape flagged in the `loyalty` plan's diverges list.
   Two concurrent checkouts both reading the same `PENDING` voucher could both pass the
   check before either writes. This plan uses `SELECT ... FOR UPDATE` inside the sale's
   own transaction (Phase 4), mirroring `pos`'s own `lockAndValidateProducts` stock-lock
   pattern and `reservation`'s overlap-lock — the exact discipline this codebase already
   established for every other double-spend-shaped problem.
5. **oikos's `PENDING` status name is a confusing label for "not yet used."** This plan
   renames it `"active"` for clarity (Pass 2's schema) — a naming fix, not a behavior
   change.
6. **`metadataJson` catch-all** — not carried forward, matching the `loyalty` plan's
   same call.

Where this plan matches oikos: the core shape (a unique `code` per tenant, an optional
link to a promo, an optional link to a specific customer, a status lifecycle ending in
`redeemed`/`cancelled`/`expired`) is sound and is kept.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff/Admin/Owner** — issue a voucher to a specific customer (a goodwill gesture, a
  gift purchased over the counter), look up a voucher by code, cancel an unused one.
- **Cashier (POS checkout)** — the primary interaction: at checkout, enter a voucher
  code; if valid, the sale total is discounted and the voucher is consumed in the same
  transaction as the sale (Phase 4 — depends on `pos`'s own checkout route existing).
- **Customer (portal)** — **not built in this pass**, same open question every Wave 2
  module has flagged; a customer cannot self-view their issued vouchers yet.
- **Platform admin** — not built, same as every prior module.

**Workflow:** Staff issues a ₱200 gift voucher to a customer (or a promo campaign
auto-mints one — see `promos`' plan) — the customer gets a code (shown on screen/printed/
texted, delivery mechanism out of scope, see Out of Scope). Later, at checkout, the
cashier types the code into the POS cart; the system validates it (not expired, not
already redeemed, belongs to this customer if it's customer-locked) and applies the
discount to the sale total before payment. The voucher flips to `redeemed`, permanently
linked to that sale.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()`.
- A caller without `voucher:manage` attempting to issue/cancel → 403. (Redemption itself
  rides on the checkout caller's existing `pos` permission — see Permission vocabulary;
  no separate gate needed for the redeem step.)
- **Redeeming an already-redeemed/cancelled/expired voucher** → 400 at checkout (the
  sale itself still succeeds without the discount, or the checkout is rejected entirely
  — **Open Question 1** asks which). Checked under `SELECT ... FOR UPDATE` inside the
  sale transaction.
- **Redeeming a customer-locked voucher against a different customer's sale** → 400 —
  the voucher's `memberId`, if set, must match the sale's `memberId`.
- A voucher `code` that doesn't exist for the caller's tenant → 404 (issue/lookup routes)
  or a checkout-time 400 (validation failure, not an existence leak — the cashier is
  told "invalid code," not "no such tenant").
- **Two concurrent checkouts race-redeeming the same voucher** → exactly one succeeds;
  the loser sees the sale complete without the discount (or rejected — Open Question 1),
  never a double-discount.
- **Tenant-isolation leak scenario**: tenant A's voucher code must never validate against
  tenant B's checkout, even if the codes happen to collide (the unique index is per-
  tenant, so two tenants *can* mint the identical code string) — a lookup always scopes
  by `tenantId` first.

**Audit / notifications:** every issue/cancel/redemption writes a `recordStaffAudit`
entry (`chronoVoucher.issued` / `.cancelled` / `.redeemed`), capturing the code, the
discount applied, and (for redemption) the sale it was applied to. No SMS/email delivery
of the code in this pass — see Out of Scope.

---

## Pass 2 — Technical Planning

### Pattern to copy

- `apps/chrono-api/src/modules/pos/schema.ts` — `chronoSale`'s existing shape (this
  plan's `redeemedAgainstSaleId` FKs directly into it, since it's already on disk) and
  the "walk-in, nullable `memberId`" precedent this plan reuses for a non-customer-
  locked voucher.
- `apps/chrono-api/src/modules/reservation/service.ts` — the
  `SELECT ... FOR UPDATE`-then-validate-then-write pattern this plan's redemption guard
  follows.
- `apps/chrono-api/src/modules/shift/schema.ts` — the partial-unique-index-as-DB-
  backstop convention; this plan's `uniqueIndex` on `(tenantId, code)` is the same
  shape, just an exact-match uniqueness rather than a partial one.
- `.ai/rules/business-app.md` — module folder: `apps/chrono-api/src/modules/voucher/`
  (singular, per Naming) with `schema.ts`/`contracts.ts`/`service.ts`/`routes.ts`.
- `apps/chrono-api/src/auth/permissions.ts` + `require-permission.ts` — per-app
  extension seam, exactly like `reservation`/`loyalty`.

### Schema — `apps/chrono-api/src/modules/voucher/schema.ts`

```ts
import { pgTable, text, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoSale } from "../pos/schema";

export const chronoVoucher = pgTable(
  "ChronoVouchers",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Nullable — set only when this voucher was minted as part of a promos
    // campaign (see the sibling `promos` plan). A staff-issued one-off gift
    // voucher has no promo behind it. onDelete restrict: a promo's issuance
    // history must survive even if the promo campaign row is later archived
    // (promos are archived, not hard-deleted, per that plan's own design —
    // restrict is a backstop, not an expected path).
    promoId: text("promoId"),
    code: text("code").notNull(),
    // "percentage" | "fixed_amount" — see "diverges from oikos" #2.
    discountType: text("discountType").notNull(),
    discountValue: numeric("discountValue", { precision: 12, scale: 2 }).notNull(),
    // Nullable — a customer-locked voucher (issued to a specific member) vs a
    // generic redeemable-by-anyone code. See "diverges from oikos" #3 for why
    // this must be representable independent of promoId.
    memberId: text("memberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // "active" | "redeemed" | "cancelled" — deliberately no stored "expired"
    // state (see "diverges from oikos" #5's naming fix plus this: expiry is
    // computed from expiresAt at validation time, not a status a sweep job
    // has to keep in sync — oikos has no such sweep for vouchers either, so
    // this isn't a regression, just avoiding inventing one).
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expiresAt"),
    redeemedAt: timestamp("redeemedAt"),
    // Real FK — chronoSale already exists on disk, unlike wallet's own
    // forward-reference TODO in pos/schema.ts.
    redeemedAgainstSaleId: text("redeemedAgainstSaleId").references(() => chronoSale.id, {
      onDelete: "set null",
    }),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: text("cancelReason"),
    issuedByUserId: text("issuedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_voucher_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_voucher_tenant_code_uq").on(t.tenantId, t.code),
    index("chrono_voucher_member_idx").on(t.memberId),
    index("chrono_voucher_promo_idx").on(t.promoId),
    index("chrono_voucher_status_idx").on(t.status),
  ],
);

export type NewChronoVoucher = typeof chronoVoucher.$inferInsert;
export type ChronoVoucherRow = typeof chronoVoucher.$inferSelect;
```

**Scope call: single-use, all-or-nothing redemption only** — no partial-balance
stored-value gift cards (spend ₱50 of a ₱200 voucher, keep ₱150 for later). oikos itself
never modeled that either; adding it now would mean a second ledger table (mirroring
`wallet`'s), a materially bigger feature than "redeemable discount code." **Open
Question 2** flags this as a deliberate scope line, not an oversight.

**`promoId` is a bare `text` column with no FK constraint declared above** — deliberate,
mirroring `pos/schema.ts`'s own `walletTransactionId` forward-reference precedent: the
`promos` plan (sibling, landing in the same window) may not have its schema on disk yet
depending on landing order. Add the real `.references(() => chronoPromo.id, { onDelete:
"restrict" })` once `promos/schema.ts` exists — a one-line follow-up migration, not a
redesign, exactly like `pos`'s own documented TODO for `chronoWalletTransaction`.

### `APP_TENANT_TABLES`

Add `"ChronoVouchers"` to `apps/chrono-api/src/db/schema.ts`. Check current state first —
`loyalty`/`promos` may be landing in the same window.

### Contracts — `apps/chrono-api/src/modules/voucher/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const voucherStatusSchema = z.enum(["active", "redeemed", "cancelled"]);
export const discountTypeSchema = z.enum(["percentage", "fixed_amount"]);

const percentageValueSchema = z.number().positive().max(100);
const fixedAmountValueSchema = z.number().positive();

export const issueVoucherSchema = z
  .object({
    promoId: z.string().min(1).optional(),
    discountType: discountTypeSchema,
    discountValue: z.number().positive(),
    memberId: z.string().min(1).optional(), // omit for a generic, anyone-redeemable code
    code: z.string().min(4).max(50).optional(), // auto-generated if omitted
    expiresAt: z.string().datetime().optional(),
  })
  .refine(
    (v) => (v.discountType === "percentage" ? v.discountValue <= 100 : true),
    { message: "A percentage discount cannot exceed 100.", path: ["discountValue"] },
  );

export const cancelVoucherSchema = z.object({ reason: z.string().max(255).optional() });

export const validateVoucherSchema = z.object({
  code: z.string().min(1),
  memberId: z.string().min(1).optional(), // the sale's own member, if any
  subtotal: z.string().regex(/^\d+(\.\d{1,2})?$/), // used to compute the discount amount
});

export const voucherListQuerySchema = listQuerySchema(["createdAt", "expiresAt"]).extend({
  status: voucherStatusSchema.optional(),
  memberId: z.string().optional(),
  code: z.string().optional(),
});

export type IssueVoucherInput = z.infer<typeof issueVoucherSchema>;
export type CancelVoucherInput = z.infer<typeof cancelVoucherSchema>;
export type ValidateVoucherInput = z.infer<typeof validateVoucherSchema>;
export type VoucherStatus = z.infer<typeof voucherStatusSchema>;
export type DiscountType = z.infer<typeof discountTypeSchema>;
```

### Service — `apps/chrono-api/src/modules/voucher/service.ts`

```ts
/** Pure function — no DB access. */
export function computeDiscount(discountType: DiscountType, discountValue: string, subtotal: string): string { /* percentage: subtotal * value/100; fixed_amount: min(value, subtotal) — never discounts below zero */ }

/**
 * Locks the voucher row (SELECT ... FOR UPDATE), validates it is active,
 * not expired, and (if memberId is set) matches the sale's own memberId.
 * Does NOT mutate the row — callers decide when to actually commit the
 * redemption (see redeemVoucher), so a checkout preview/quote can call this
 * without side effects.
 */
async function lockAndValidateVoucher(tx: TenantTx, args: { tenantId: string; code: string; memberId?: string }): Promise<ChronoVoucherRow> { /* throws HttpError(400, ...) on any failure */ }

/** Called from inside pos's checkout transaction once a sale row exists. */
export async function redeemVoucher(tx: TenantTx, args: { tenantId: string; code: string; memberId?: string; saleId: string }): Promise<{ voucher: ChronoVoucherRow; discountAmount: string }> { /* lockAndValidateVoucher, then update status/redeemedAt/redeemedAgainstSaleId */ }

/** Called from a sale-refund flow (once pos has one) to reverse a redemption. */
export async function reverseVoucherRedemption(tx: TenantTx, args: { tenantId: string; saleId: string }): Promise<void> { /* find voucher WHERE redeemedAgainstSaleId = saleId, flip back to active, clear redeemedAt/redeemedAgainstSaleId */ }
```

### Routes — `apps/chrono-api/src/modules/voucher/routes.ts`

A Hono factory `voucherRoutes()` typed on `TenantVars`, composed via
`.route("/vouchers", voucherRoutes())`:

- `GET /` — `voucher:read`. Paginated, filterable by status/member/code.
- `GET /:id` — `voucher:read`. 404 cross-tenant.
- `POST /` — `voucher:manage`. `issueVoucherSchema`; looks up `promoId`/`memberId` inside
  `withTenant` first (404 if foreign); auto-generates `code` if omitted (an 8-char
  alphanumeric, uniqueness enforced by the DB index — retry once on collision);
  `recordStaffAudit("chronoVoucher.issued", ...)`.
- `POST /:id/cancel` — `voucher:manage`. 409 if already `redeemed`/`cancelled`.
  `recordStaffAudit("chronoVoucher.cancelled", ...)`.
- `POST /validate` — `voucher:read` (a dry-run check, e.g. for a checkout UI to show
  "this code is valid, -₱50" before the cashier commits the sale). Calls
  `lockAndValidateVoucher` **outside** the sale transaction as a preview only — a real
  redemption still happens inside `pos`'s own checkout transaction (Phase 4), so this
  preview result can theoretically go stale between the check and the real checkout;
  the checkout's own lock is the actual guarantee, this route is UX sugar only.

No `DELETE` — cancel is the only removal path, matching every prior module's immutable-
audit-trail precedent.

### Permission vocabulary

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  voucher: ["read", "manage"],
} satisfies Record<string, string[]>;
```

- `staffRole` grant — `voucher: ["read", "manage"]`. Issuing a customer a goodwill
  voucher and cancelling an unused one is routine front-desk/customer-service work, the
  same tier `reservation`'s `manage` established — not a store-wide pricing/margin
  decision the way `promos` (see that plan) is.
- `adminRole` grant — inherits the same set (no split in this pass). `ownerRole` needs
  no explicit grant.
- **Redemption itself needs no new permission** — it happens as a side effect inside the
  POS checkout call, which is already gated by `pos:sell` (that permission, once `pos`'s
  own plan defines it, is the real gate on "can this actor even run a checkout"). Adding
  a separate `voucher:redeem` would just duplicate that gate for no behavioral
  difference. **Open Question 3** flags this for confirmation if the developer wants
  redemption auditable as a distinct permission regardless.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List | `GET /rpc/vouchers` | `voucher:read` | paginated, filterable by status/member/code |
| Detail | `GET /rpc/vouchers/:id` | `voucher:read` | 404 cross-tenant |
| Issue | `POST /rpc/vouchers` | `voucher:manage` | 404 on foreign promo/member |
| Cancel | `POST /rpc/vouchers/:id/cancel` | `voucher:manage` | 409 if already redeemed/cancelled |
| Validate (preview) | `POST /rpc/vouchers/validate` | `voucher:read` | UX-only preview, not the real redemption guard |
| Redeem | (inline, inside POS checkout) | `pos:sell` (reused) | Phase 4, blocked on `pos`'s checkout route |
| Delete | — | — | not built — cancel is the only removal |

Feedback: `toast.success`/`toast.error`, surfacing "invalid/expired/already-redeemed
code" verbatim at the checkout UI.

Audit linkage: `recordStaffAudit` on issue/cancel/redeem, each entry capturing the code
and (for redeem) the sale id and discount amount.

### Web UI

- **`apps/chrono-web/src/app/dashboard/vouchers/page.tsx` (new)**: `DataTable` of
  vouchers (code, discount, status badge, member, expiry), `useListQuery()`, a status
  filter.
- An **Issue** `Dialog`: discount type/value inputs, member search/generic toggle,
  optional expiry date-time input (reuse the `DateTimeInput` primitive `reservations`
  added to `agora/ui`, per `.ai/rules/component-first-ui.md` — don't invent a second
  one).
- The POS checkout screen (once it exists, `pos`'s own plan/phase) gets a **voucher code
  field** calling `POST /rpc/vouchers/validate` for a live preview and passing the code
  through to the checkout submit — this plan's Phase 4/5 amend that screen once it
  exists; this plan does not build the POS screen itself.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add `Vouchers` to `BASE_NAV`/`TITLES`.

### Out of Scope (this plan)

- **The actual checkout-time redemption wiring** (Phase 4) — blocked on `pos`'s own
  checkout route; this plan's schema/contracts/service function are ready for it, but
  nothing calls `redeemVoucher` until that route exists.
- **Partial-balance stored-value gift cards** — Open Question 2; all-or-nothing single
  redemption only.
- **SMS/email delivery of an issued voucher's code** — trivial follow-up once a
  notification-channel module exists.
- **A customer-facing "my vouchers" portal view** — no portal surface exists yet.
- **Bulk-issue** (mint N vouchers from one promo in one call) — this plan issues one
  voucher per call; bulk minting belongs to the `promos` plan if/when a campaign needs
  to hand out many codes at once (see that plan's own Out of Scope).
- **The `/rpc-admin` platform-admin cross-tenant view** — no resource exists for this
  today.
- Module-registry (`modules.voucher`) feature-flag gating.
- Any `pos`/`promos` route code — separate, sibling plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/voucher/schema.ts` (new).
- `apps/chrono-api/src/db/schema.ts` — import/re-export, add `"ChronoVouchers"` to
  `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Verify `apps/chrono-api/src/modules/pos/schema.ts` exists (it does) — this module's
   `redeemedAgainstSaleId` FK imports `chronoSale` from it.
2. Create `apps/chrono-api/src/modules/voucher/` and write `schema.ts` exactly as
   specified in Pass 2.
3. Update `db/schema.ts` — check current state first (`loyalty`/`promos` may land in the
   same window).
4. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_vouchers`. Review:
   one `CREATE TABLE`, five indexes, two FKs (`memberId`, `redeemedAgainstSaleId`), no
   destructive statements.
5. `pnpm --filter @agora/chrono-api db:migrate`.

**Acceptance criteria**

- `ChronoVouchers` exists with `FORCE ROW LEVEL SECURITY` on.
- `"ChronoVouchers"` present in `APP_TENANT_TABLES`.
- Migration reviewed, no destructive statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** contracts, service, routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/voucher/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/voucher/contracts.ts` (new).

**Step-by-step tasks**

1. Write every schema from Pass 2's Contracts section, including the percentage-cap
   `.refine`.
2. Export `z.infer` types.

**Acceptance criteria**

- All schemas compile and are importable.
- `issueVoucherSchema` rejects a `percentage` `discountValue` over 100.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/voucher/contracts.ts`.

---

## Phase 3 — Service + standalone routes + permission gates

**Files to update**

- `apps/chrono-api/src/auth/permissions.ts` — add `voucher: ["read", "manage"]` to
  `CHRONO_PERMISSION_STATEMENTS`, `CHRONO_STAFF_GRANTS`, `CHRONO_ADMIN_GRANTS`.
- `apps/chrono-api/src/modules/voucher/service.ts` (new) — `computeDiscount`,
  `lockAndValidateVoucher`, `redeemVoucher`, `reverseVoucherRedemption` (Pass 2;
  `redeemVoucher`/`reverseVoucherRedemption` are written now but have no caller until
  Phase 4).
- `apps/chrono-api/src/modules/voucher/routes.ts` (new) — `voucherRoutes()`.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/vouchers", voucherRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — `voucher` gate cases.
- `apps/chrono-api/src/modules/voucher/service.test.ts` (new) — concurrency test:
  seed one active voucher, fire `N` concurrent `redeemVoucher` calls (against synthetic
  distinct sale ids, or the same one — pick whichever isolates the race cleanest) for
  the same code, assert exactly one succeeds and `N-1` throw.

**Step-by-step tasks**

1. Add `voucher` to `permissions.ts`.
2. Write `service.ts` per Pass 2, with the `SELECT ... FOR UPDATE` discipline inside
   `lockAndValidateVoucher`/`redeemVoucher`.
3. Write `routes.ts`: `GET /`, `GET /:id`, `POST /`, `POST /:id/cancel`,
   `POST /validate`, all gated via `requirePermission`, mutations inside `withTenant` +
   `recordStaffAudit`.
4. Compose into `rpc.ts`.
5. Add `voucher` gate cases to `permissions.test.ts`.
6. Write the redemption concurrency test directly against `service.ts` (it doesn't need
   the checkout route to exist — `redeemVoucher` is a plain `tx`-scoped function callers
   can invoke from a test harness directly, same technique `reservation`'s
   `overlap.test.ts` uses against `assertNoOverlap`).

**Acceptance criteria**

- `GET /rpc/vouchers` returns `{ items, meta }`.
- `POST /rpc/vouchers` issues successfully; auto-generates a code when omitted; 404 on a
  foreign `promoId`/`memberId`.
- `POST /rpc/vouchers/:id/cancel` → 409 if already terminal.
- `POST /rpc/vouchers/validate` correctly reports invalid for an expired/redeemed/
  cancelled/wrong-member code.
- The `redeemVoucher` concurrency test passes deterministically.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new cases.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test`

**Out of scope:** the actual checkout wiring (Phase 4), UI, e2e.

**Execution start point:** edit `apps/chrono-api/src/auth/permissions.ts` first.

---

## Phase 4 — POS checkout integration (BLOCKED)

**Blocked on:** `apps/chrono-api/src/modules/pos/routes.ts` existing — it does not
today. This phase amends that file (and, if a refund route exists by then, wires
`reverseVoucherRedemption` into it) once it lands. Coordinate with whoever implements
`pos`'s own Phase 3 — this is the natural point to build both together, since `pos`'s
checkout body needs a `voucherCode?: string` field added to its own `checkoutSchema` and
`voucher`'s `redeemVoucher` needs the sale row's id, which only exists once the sale
insert has happened inside that same transaction.

**Files to update (once unblocked)**

- `apps/chrono-api/src/modules/pos/contracts.ts` — add `voucherCode: z.string().optional()`
  to `checkoutSchema`.
- `apps/chrono-api/src/modules/pos/routes.ts` — inside the checkout transaction: insert
  the sale row first (so a `saleId` exists), then call `redeemVoucher(tx, { tenantId,
  code: voucherCode, memberId: sale.memberId, saleId: sale.id })` if a code was
  provided, subtract `discountAmount` from `totalAmount` before computing `changeAmount`
  (this changes the order of operations from a naive "compute total, then discount,
  then insert" — the sale row's `totalAmount` must reflect the discount, so either the
  discount is computed *before* the insert using the preview path, or the sale row is
  updated in the same transaction immediately after — pick whichever the actual
  `pos/routes.ts` checkout structure makes cleaner once it exists, don't guess now).
- If `pos` has a refund route by the time this phase runs: call
  `reverseVoucherRedemption(tx, { tenantId, saleId })` inside the refund transaction.

**Step-by-step tasks**

1. Confirm `pos/routes.ts` exists and read its checkout transaction structure.
2. Add `voucherCode` to `checkoutSchema`.
3. Wire `redeemVoucher` into the checkout transaction per the ordering note above.
4. If a refund route exists, wire `reverseVoucherRedemption` into it.
5. Write a concurrency test at the checkout-route level (not just the service-level one
   from Phase 3): two concurrent checkouts submitting the same voucher code → exactly
   one sale gets the discount, the other completes without it (or is rejected — resolve
   Open Question 1 before writing this test).

**Acceptance criteria**

- A checkout with a valid voucher code produces a `ChronoSale` with the discounted
  `totalAmount` and a `ChronoVoucher` row flipped to `redeemed` with the correct
  `redeemedAgainstSaleId`.
- An invalid/expired/already-redeemed code surfaces the exact failure reason (Open
  Question 1 resolves whether the whole checkout is rejected or just proceeds
  undiscounted).
- The route-level concurrency test passes deterministically.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pos`'s own test suite, extended with the voucher-discount assertions.

**Out of scope:** UI (Phase 5 covers the standalone voucher management screen; the
checkout screen's own voucher-code field is `pos`'s own UI phase to build, this plan
only supplies the `validate` endpoint for it to call).

**Execution start point:** re-check `pos/routes.ts` for existence before starting.

---

## Phase 5 — Web UI (standalone voucher management)

**Files to update**

- `apps/chrono-web/src/app/dashboard/vouchers/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — nav entry + title.

**Step-by-step tasks**

1. Build `page.tsx` per Pass 2's Web UI section.
2. Build the Issue `Dialog`.
3. Wire `toast.success`/`toast.error`.
4. Add nav entry + title.

**Acceptance criteria**

- `/dashboard/vouchers` renders, search/sort/paginate/status-filter update the URL.
- Issue/cancel submit successfully and the list refreshes.
- No raw HTML chrome introduced.

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** the POS checkout screen's voucher field — that's `pos`'s own UI phase.

**Execution start point:** create `apps/chrono-web/src/app/dashboard/vouchers/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/vouchers/vouchers.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec covering:
   - **Happy path**: issue a voucher, confirm it appears `active`; cancel a second one,
     confirm its status updates. (The full checkout-redemption happy path belongs in
     `pos`'s own e2e spec once Phase 4 lands — cross-reference it here rather than
     duplicating it.)
   - **Role gate**: a non-member/unauthenticated request to `/rpc/vouchers` is refused
     (this pass grants staff/admin/owner the same actions, mirroring `reservation`'s own
     framing).
   - **Tenant isolation**: tenant A's voucher code is invisible from tenant B's list and
     a direct cross-tenant `GET /:id` returns 404.
2. Use `@faker-js/faker` per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three cases pass locally against `pnpm dev`.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/vouchers/vouchers.spec.ts`

**Out of scope:** the checkout-redemption e2e path (belongs to `pos`'s own spec once
Phase 4 lands).

**Execution start point:** create
`apps/chrono-web/e2e/tests/vouchers/vouchers.spec.ts`.

---

## Open Questions (developer to confirm/override)

1. **Invalid voucher at checkout: reject the whole sale, or proceed undiscounted?** This
   plan's Phase 4 doesn't resolve this — confirm before writing that phase's tests.
2. **Partial-balance stored-value gift cards** — explicitly out of scope (all-or-nothing
   single redemption only). Confirm, or scope a follow-up ledger-backed design.
3. **A dedicated `voucher:redeem` permission** — this plan reuses `pos:sell` as the
   implicit gate on redemption. Confirm that's acceptable, or split one out if the
   developer wants redemption independently auditable/permissioned from checkout itself.
4. **Voucher code delivery (SMS/email)** — out of scope; confirm deferral.
5. **Bulk-issue from a promo campaign** — this plan issues one voucher per call; confirm
   whether `promos` should own bulk-minting or whether it belongs here as a follow-up.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/vouchers/` to
`.ai/plans/chrono/archive/vouchers/` once all six phases are verified and committed
separately (Phase 4 is blocked and may land later than the rest — don't hold the other
phases hostage to it). Update `.ai/handover/chrono-migration.md`'s Plan status table.
