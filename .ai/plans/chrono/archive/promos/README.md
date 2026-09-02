# Chrono — `promos` module

**Depends on:** `branches` (implemented, optional branch-scoping FK) and `pos` for its
actual purpose — applying a campaign's discount at checkout. **`pos` today has only
`schema.ts` + `contracts.ts` — no `service.ts`/`routes.ts`.** Same structural blocker the
sibling `vouchers` plan flags: there is no live checkout endpoint to apply a promo
against yet. This plan also has a **soft** dependency on `vouchers` (this plan's sibling,
same window): a promo can optionally mint vouchers, so `chronoVoucher.promoId`'s real FK
(currently a bare `text` column per that plan's own note) gets wired up once this
module's schema exists — order-of-landing between `vouchers` and `promos` doesn't matter
functionally, just note it when wiring that one FK.

## What this is

A time-bounded pricing campaign — "20% off all sales this weekend," "₱50 off orders over
₱500 in March" — that either auto-applies to a matching sale during its active window,
or requires a customer to type in a coupon code, discounting the sale total at POS
checkout. This is the tenant-wide, config-level sibling to `vouchers`' per-customer
instance: a `promos` row is store policy; a `vouchers` row (this module can optionally
mint some) is a specific redeemable code handed to one customer.

## Prior art and where this plan diverges from it

Read at `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/database/schema/promos.ts`
(`Promo` table) + `src/modules/promos/{service,dto}.ts` (no `routes.ts` was found for
`promos` itself in the grep — only `vouchers/routes.ts` and the `PROMO_PACKAGE` red
herring inside `pos/routes.ts`, described in the `vouchers` plan). Same core finding as
that sibling plan: **oikos's `Promo` table is CRUD-only, never consulted by checkout.**
There is no code path anywhere in oikos's `pos` module that reads an active `Promo` row
and reduces a sale's total. The feature this task asks for — "applied at POS checkout" —
is new design work here, not a port, exactly as the `vouchers` plan found for its own
scope.

Beyond that shared finding, `promos`' own schema and service have gaps distinct from
`vouchers`':

1. **No usage-limit tracking of any kind.** A `Promo` is a reusable `code` — nothing
   caps how many times it can be used in total, or by one customer. In a real system, an
   unlimited-use "20% off" code is a margin-erosion bug waiting to happen the first time
   it leaks past its intended audience. This plan adds `maxRedemptions` (nullable, total
   cap) and `maxRedemptionsPerMember` (nullable, default `1`), enforced against a new
   **`ChronoPromoRedemptions`** ledger table — oikos has no equivalent table at all, so
   this isn't a port of a weak design, it's closing a real, missing constraint.
2. **`startsAt`/`expiresAt` appear to be dead columns.** Neither `promoService.listPromos`
   nor `getPromo`/`getPromoByCode` filters or validates against either column anywhere
   in the code read. A promo whose `expiresAt` has passed still shows as `ACTIVE`
   (status is a separate, manually-set field, never auto-transitioned) and, since
   nothing ever checks the dates at all, would still "work" if anything had wired it to
   checkout. This plan makes the date window a real, enforced guard at
   validation/redemption time (Phase 4) — not a cosmetic field.
3. **No branch-scoping enforcement visible beyond storage.** `Promo.branchId` is stored
   and joined for display in `listPromos`, but nothing in the read path actually
   requires a sale's own branch to match before allowing the discount (there's no
   redemption code to check, per the finding above). This plan enforces it explicitly
   once wired to checkout (Phase 4): a branch-scoped promo only validates for a sale at
   that branch.
4. **`type`/`value` double duty**, same issue flagged in the `vouchers` plan for the
   identical column pair on the same table (`'DISCOUNT' | 'FREE_CREDIT'` sharing one
   numeric `value`). This plan splits `discountType` (`"percentage" | "fixed_amount"`)
   from `discountValue`, matching `vouchers`' own fix for consistency between the two
   sibling modules — a promo and the voucher it mints should describe a discount
   identically.
5. **`EXPIRED`/`ARCHIVED` as manually-set statuses, not derived state.** oikos's
   `PromoStatusEnum` includes `EXPIRED` as something a caller would have to set by hand
   (no code sets it) — a phantom status nothing transitions into. This plan drops
   `EXPIRED` as a stored value entirely; expiry is a computed property of `endsAt` at
   read/validate time (same call the `vouchers` plan makes for its own status set),
   avoiding the need for a sweep job just to keep a status field honest.
6. **No mode for "applies automatically, no code needed."** oikos's `Promo.code` is
   `NOT NULL` — every promo requires a customer to type something in, even a "20% off
   the whole store this weekend" campaign that should just apply itself. This plan makes
   `code` nullable: present means "coupon mode" (customer/staff must enter it), absent
   means "auto-apply mode" (the checkout route finds and applies the best matching
   active promo with no code needed) — a materially more useful shape for the actual
   product need described in this task ("time-bounded promotional pricing/campaigns"),
   not just a discount-code box.
7. **`metadataJson` catch-all** — not carried forward, same call as `loyalty`/`vouchers`.

Where this plan matches oikos: `minSpend` as an optional threshold and per-tenant unique
`code` are both kept — sound, simple mechanisms with nothing wrong to fix.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Admin/Owner** — create/update/pause/archive a campaign (see Permission vocabulary —
  this plan draws an admin+-only line here, unlike `reservation`'s/`voucher`'s
  staff-tier default; see reasoning below).
- **Staff** — read-only visibility into active campaigns (so a cashier can tell a
  customer "yes, that promo is running"), no create/edit/archive.
- **Cashier (POS checkout)** — the primary interaction, same as `vouchers`: either an
  auto-applying promo silently discounts a matching sale, or the cashier enters a coupon
  code (Phase 4 — blocked on `pos`'s checkout route).
- **Customer (portal)** — not built in this pass, same standing open question.
- **Platform admin** — not built.

**Workflow:** An owner sets up "Weekend Special — 15% off, this Sat–Sun only, min spend
₱200" with no code (auto-apply). During that window, every qualifying POS sale gets the
discount with no cashier action needed. Separately, an admin creates "WELCOME10 — 10%
off, one per new customer" as a coupon-mode promo (has a `code`, `maxRedemptionsPerMember:
1`) — a cashier types `WELCOME10` at checkout for a first-time customer; a second attempt
by the same customer is rejected. A promo can be paused mid-run (temporarily stops
applying without losing its configuration) or archived (permanently retired).

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()`.
- A `staff` caller attempting create/update/pause/archive → 403 (`promo:manage` is
  admin+-only — see Permission vocabulary).
- **A coupon code that doesn't exist, is paused/archived, outside its
  `startsAt`–`endsAt` window, below `minSpend`, or at/over `maxRedemptions`/
  `maxRedemptionsPerMember`** → 400 at checkout with a specific reason, never a generic
  "invalid."
- **Two concurrent checkouts both redeeming the last remaining slot of a
  `maxRedemptions`-capped promo** → exactly one succeeds, checked under
  `SELECT ... FOR UPDATE` against the promo row plus a `COUNT` of its
  `ChronoPromoRedemptions` inside the same transaction — the identical double-spend
  discipline `vouchers`'/`pos`'s/`reservation`'s guards already use.
- A `branchId` on a branch-scoped promo that doesn't belong to the caller's tenant → 404
  on create/update, looked up inside `withTenant`.
- **Tenant-isolation leak scenario**: tenant A's promo `code` must never validate against
  tenant B's checkout, even on a colliding code string (a per-tenant unique index, same
  shape `vouchers` uses).

**Audit / notifications:** every create/update/pause/archive/redemption writes a
`recordStaffAudit` entry (`chronoPromo.created` / `.updated` / `.paused` / `.archived` /
`.redeemed`), capturing the discount applied and, for redemption, the sale it applied to.

---

## Pass 2 — Technical Planning

### Pattern to copy

- `apps/chrono-api/src/modules/voucher/schema.ts` (sibling plan, same window) — the
  `discountType`/`discountValue` split this plan mirrors for consistency, and the
  `SELECT ... FOR UPDATE`-then-validate service shape.
- `apps/chrono-api/src/modules/wallet/schema.ts` — the account-row +
  append-only-ledger-row shape; `ChronoPromos`/`ChronoPromoRedemptions` follow the same
  split (a mutable campaign row + an immutable usage ledger), substituting "was this
  campaign used" for "what is this account's balance."
- `apps/chrono-api/src/modules/branch/schema.ts` — the optional-branch-scoping FK
  pattern (`station`'s `stationGroupId` nullable-FK precedent, applied here to
  `branchId`).
- `.ai/rules/business-app.md` — module folder: `apps/chrono-api/src/modules/promo/`.
- `apps/chrono-api/src/auth/permissions.ts` + `require-permission.ts` — per-app
  extension seam.

### Schema — `apps/chrono-api/src/modules/promo/schema.ts`

```ts
import { pgTable, text, integer, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoSale } from "../pos/schema";

export const chronoPromo = pgTable(
  "ChronoPromos",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Nullable — tenant-wide when unset, matching branch's own optional-scope
    // precedent elsewhere in this codebase.
    branchId: text("branchId").references(() => chronoBranch.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // Nullable — present means "coupon mode" (a customer/staff must enter it
    // at checkout); absent means "auto-apply mode" (checkout finds and
    // applies the best matching active promo with no code). See
    // "diverges from oikos" #6. Unique per tenant only when set — see the
    // partial unique index below.
    code: text("code"),
    description: text("description"),
    // "active" | "paused" | "archived" — no stored "expired"; see
    // "diverges from oikos" #5. A promo past its endsAt is treated as
    // inactive at validation time regardless of this column's value.
    status: text("status").notNull().default("active"),
    discountType: text("discountType").notNull(), // "percentage" | "fixed_amount"
    discountValue: numeric("discountValue", { precision: 12, scale: 2 }).notNull(),
    minSpend: numeric("minSpend", { precision: 12, scale: 2 }),
    // Nullable — "active immediately" when unset.
    startsAt: timestamp("startsAt"),
    // NOT nullable — a promo is, by this task's own framing, "time-bounded."
    // Forcing a real end date is a deliberate improvement over oikos's fully
    // optional expiresAt (see "diverges from oikos" #2: an unenforced,
    // sometimes-absent expiry is how a promo silently runs forever).
    endsAt: timestamp("endsAt").notNull(),
    maxRedemptions: integer("maxRedemptions"),
    maxRedemptionsPerMember: integer("maxRedemptionsPerMember").default(1),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_promo_tenant_idx").on(t.tenantId),
    // Partial unique index — only enforces uniqueness among rows that
    // actually have a code (auto-apply promos with code: null never
    // collide with each other). Mirrors shifts' own partial-unique-index
    // convention (`.where(sql...)`).
    uniqueIndex("chrono_promo_tenant_code_uq")
      .on(t.tenantId, t.code)
      .where(sql`"code" IS NOT NULL`),
    index("chrono_promo_status_idx").on(t.status),
    index("chrono_promo_branch_idx").on(t.branchId),
    index("chrono_promo_window_idx").on(t.startsAt, t.endsAt),
  ],
);

export const chronoPromoRedemption = pgTable(
  "ChronoPromoRedemptions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // restrict, not cascade — a promo's usage history must survive even if
    // the campaign is later archived (archived, not hard-deleted, is the
    // only lifecycle end-state a promo has in this plan — see Routes).
    promoId: text("promoId")
      .notNull()
      .references(() => chronoPromo.id, { onDelete: "restrict" }),
    memberId: text("memberId").references(() => base.tenantMember.id, { onDelete: "set null" }),
    // set null: a sale is never hard-deleted in this codebase's convention,
    // but this stays defensive rather than assuming that forever.
    saleId: text("saleId").references(() => chronoSale.id, { onDelete: "set null" }),
    // Snapshot of the amount actually discounted on that sale — immutable,
    // same "snapshot at time of action" principle as pos's ChronoSaleItem
    // name/sku/unitPrice columns.
    discountAmount: numeric("discountAmount", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_promo_redemption_tenant_idx").on(t.tenantId),
    index("chrono_promo_redemption_promo_idx").on(t.promoId),
    index("chrono_promo_redemption_member_idx").on(t.memberId),
  ],
);

export type NewChronoPromo = typeof chronoPromo.$inferInsert;
export type ChronoPromoRow = typeof chronoPromo.$inferSelect;
export type NewChronoPromoRedemption = typeof chronoPromoRedemption.$inferInsert;
export type ChronoPromoRedemptionRow = typeof chronoPromoRedemption.$inferSelect;
```

**Scope call: a promo discounts the sale subtotal as a whole, never individual line
items/categories.** oikos never modeled per-item/category targeting either (beyond
`minSpend`); adding it now is real, separate scope (a targeting-rule engine) this plan
does not build. **Open Question 1** flags it.

### `APP_TENANT_TABLES`

Add `"ChronoPromos"` and `"ChronoPromoRedemptions"` to `apps/chrono-api/src/db/
schema.ts`. Check current state first — `loyalty`/`vouchers` may be landing in the same
window. **Once this file exists, go back and add the real FK to
`apps/chrono-api/src/modules/voucher/schema.ts`'s `promoId` column** (currently a bare
`text`, per that plan's own note) — a one-line follow-up migration.

### Contracts — `apps/chrono-api/src/modules/promo/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const promoStatusSchema = z.enum(["active", "paused", "archived"]);
export const promoDiscountTypeSchema = z.enum(["percentage", "fixed_amount"]);

export const createPromoSchema = z
  .object({
    branchId: z.string().min(1).optional(),
    name: z.string().min(1).max(255),
    code: z.string().min(3).max(50).optional(), // omit for auto-apply mode
    description: z.string().max(1000).optional(),
    discountType: promoDiscountTypeSchema,
    discountValue: z.number().positive(),
    minSpend: z.number().nonnegative().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime(),
    maxRedemptions: z.number().int().positive().optional(),
    maxRedemptionsPerMember: z.number().int().positive().optional(), // default 1 at the DB layer
  })
  .refine((v) => (v.discountType === "percentage" ? v.discountValue <= 100 : true), {
    message: "A percentage discount cannot exceed 100.",
    path: ["discountValue"],
  })
  .refine((v) => !v.startsAt || new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt.",
    path: ["endsAt"],
  });

export const updatePromoSchema = createPromoSchema.partial();

export const promoStatusUpdateSchema = z.object({
  status: z.enum(["active", "paused", "archived"]),
});

export const validatePromoSchema = z.object({
  code: z.string().optional(), // omit to check for an auto-applying promo
  branchId: z.string().min(1),
  memberId: z.string().min(1).optional(),
  subtotal: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

export const promoListQuerySchema = listQuerySchema(["name", "startsAt", "endsAt", "createdAt"]).extend({
  status: promoStatusSchema.optional(),
  branchId: z.string().optional(),
});

export type CreatePromoInput = z.infer<typeof createPromoSchema>;
export type UpdatePromoInput = z.infer<typeof updatePromoSchema>;
export type ValidatePromoInput = z.infer<typeof validatePromoSchema>;
export type PromoStatus = z.infer<typeof promoStatusSchema>;
export type PromoDiscountType = z.infer<typeof promoDiscountTypeSchema>;
```

### Service — `apps/chrono-api/src/modules/promo/service.ts`

```ts
function isWithinWindow(promo: ChronoPromoRow, now: Date): boolean { /* status === "active" && (!startsAt || now >= startsAt) && now < endsAt */ }

/**
 * Finds the best-matching promo for a checkout: an explicit code lookup
 * (coupon mode) or, when no code is given, the highest-discountValue active
 * auto-apply promo (code: null) matching branch/minSpend/window. Locks the
 * candidate row (SELECT ... FOR UPDATE) and, if maxRedemptions/
 * maxRedemptionsPerMember apply, COUNTs ChronoPromoRedemptions inside the
 * same transaction before accepting it — the load-bearing correctness
 * mechanism, same discipline pos's stock-lock and voucher's redemption-lock
 * use for their own double-spend problem.
 */
async function lockAndValidatePromo(tx: TenantTx, args: {
  tenantId: string; code?: string; branchId: string; memberId?: string; subtotal: string;
}): Promise<ChronoPromoRow | null> { /* throws HttpError(400, ...) for an explicit code that fails; returns null (not an error) when no code given and no auto-apply promo matches */ }

export function computeDiscount(discountType: PromoDiscountType, discountValue: string, subtotal: string): string { /* identical shape to voucher's own computeDiscount — consider extracting a shared helper if both modules land close together */ }

/** Called from inside pos's checkout transaction once a sale row exists. */
export async function redeemPromo(tx: TenantTx, args: {
  tenantId: string; promoId: string; memberId?: string; saleId: string; discountAmount: string;
}): Promise<void> { /* insert ChronoPromoRedemptions row */ }
```

### Routes — `apps/chrono-api/src/modules/promo/routes.ts`

A Hono factory `promoRoutes()` typed on `TenantVars`, composed via
`.route("/promos", promoRoutes())`:

- `GET /` — `promo:read`. Paginated, filterable by status/branch.
- `GET /:id` — `promo:read`. 404 cross-tenant.
- `POST /` — `promo:manage`. `createPromoSchema`; looks up `branchId` inside `withTenant`
  first (404 if foreign); `recordStaffAudit("chronoPromo.created", ...)`.
- `PATCH /:id` — `promo:manage`. `updatePromoSchema`. 404 cross-tenant.
  `recordStaffAudit("chronoPromo.updated", ...)`.
- `POST /:id/status` — `promo:manage`. `promoStatusUpdateSchema` (pause/archive/
  reactivate — a single status-transition route rather than three separate ones,
  since the only real invariant is "archived is terminal," enforced in the handler:
  409 attempting to transition out of `archived`). `recordStaffAudit(
  "chronoPromo.<status>", ...)`.
- `POST /validate` — `promo:read`. Dry-run preview for a checkout UI, same "UX sugar
  only, not the real guard" caveat `vouchers`' own `/validate` route documents — the
  real lock happens inside `pos`'s checkout transaction (Phase 4).

No `DELETE` — archive is the only removal path, matching every prior module's immutable-
audit-trail precedent (and required here specifically: `ChronoPromoRedemptions.promoId`
is `restrict`, so a promo with usage history could never be hard-deleted anyway).

### Permission vocabulary

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  promo: ["read", "manage"],
} satisfies Record<string, string[]>;
```

- `staffRole` grant — `promo: ["read"]` **only**. Unlike `reservation`'s and `voucher`'s
  no-split defaults, this plan draws a genuine admin+-only line for `manage`: a promo
  controls store-wide pricing/margin for every sale that matches it, for as long as it
  runs — closer in blast radius to `wallet:adjust`/`pos:manageProducts` (both admin+ in
  their own plans) than to a single customer-facing booking or a one-off voucher. A
  staff member should be able to tell a customer a promo is running (read) without being
  able to invent a 90%-off campaign themselves (manage).
- `adminRole` grant — `promo: ["read", "manage"]`. `ownerRole` needs no explicit grant.
- **Redemption itself needs no new permission**, identical reasoning to `vouchers`: it
  rides on the checkout caller's `pos:sell` gate.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List | `GET /rpc/promos` | `promo:read` | paginated, filterable by status/branch |
| Detail | `GET /rpc/promos/:id` | `promo:read` | 404 cross-tenant |
| Create | `POST /rpc/promos` | `promo:manage` | admin+-only; 404 on foreign branch |
| Update | `PATCH /rpc/promos/:id` | `promo:manage` | admin+-only |
| Pause / archive / reactivate | `POST /rpc/promos/:id/status` | `promo:manage` | admin+-only; 409 out of `archived` |
| Validate (preview) | `POST /rpc/promos/validate` | `promo:read` | UX-only preview |
| Redeem | (inline, inside POS checkout) | `pos:sell` (reused) | Phase 4, blocked on `pos`'s checkout route |
| Delete | — | — | not built — archive is the only removal, and is DB-enforced via `restrict` |

Feedback: `toast.success`/`toast.error`, surfacing the specific validation failure reason
(expired / below min spend / redemption cap reached / wrong branch) verbatim.

Audit linkage: `recordStaffAudit` on create/update/status-change/redemption, each entry
capturing the discount configuration and, for redemption, the sale and amount.

### Web UI

- **`apps/chrono-web/src/app/dashboard/promos/page.tsx` (new)**: `DataTable` of
  campaigns (name, code or "auto-apply", discount, status badge, window, redemption
  count vs cap), `useListQuery()`, a status filter. Create/edit actions visible only to
  `admin`+ via `<Can>` (staff sees the list read-only).
- A Create/Edit `Dialog`: name, optional code (toggle "requires a code" on/off), branch
  `Select` (optional), discount type/value, min spend, start/end `DateTimeInput`
  (reusing `reservations`' primitive), max redemptions / max per member.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add `Promos` to `BASE_NAV`/`TITLES`.

### Out of Scope (this plan)

- **The actual checkout-time application** (Phase 4) — blocked on `pos`'s checkout
  route, same shape as the `vouchers` plan's own Phase 4.
- **Per-line-item/category targeting** — Open Question 1; a promo discounts the whole
  sale subtotal only.
- **Bulk-minting vouchers from a promo** — `vouchers`' own Out of Scope defers this too;
  if wanted, it's a `POST /rpc/promos/:id/mint-vouchers` follow-up route calling
  `vouchers`' issue path in a loop, not built here.
- **Stacking rules** (can a promo and a voucher apply to the same sale simultaneously?)
  — **Open Question 2**, genuinely undecided; oikos has no evidence either way since
  neither is wired to checkout at all. This plan's Phase 4 default (proposed, not yet
  decided) is "at most one discount per sale, whichever the cashier/customer selects" —
  confirm before Phase 4 executes.
- **A customer-facing "browse active promos" portal view** — no portal surface exists.
- **The `/rpc-admin` platform-admin cross-tenant view** — no resource exists today.
- Module-registry (`modules.promo`) feature-flag gating.
- Any `pos`/`vouchers` route code — separate, sibling plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/promo/schema.ts` (new).
- `apps/chrono-api/src/db/schema.ts` — import/re-export, add `"ChronoPromos"`/
  `"ChronoPromoRedemptions"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Verify `apps/chrono-api/src/modules/branch/schema.ts` and
   `apps/chrono-api/src/modules/pos/schema.ts` exist (both do) — this module's FKs
   import `chronoBranch`/`chronoSale` from them.
2. Create `apps/chrono-api/src/modules/promo/` and write `schema.ts` exactly as
   specified in Pass 2, including the partial unique index on `(tenantId, code)`.
3. Update `db/schema.ts` — check current state first (`loyalty`/`vouchers` may land in
   the same window).
4. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_promos`. Review: two
   `CREATE TABLE` statements, the partial unique index, five/six indexes total, three
   FKs, no destructive statements.
5. `pnpm --filter @agora/chrono-api db:migrate`.
6. **Follow-up, once this migration lands**: add the real
   `.references(() => chronoPromo.id, { onDelete: "restrict" })` to
   `apps/chrono-api/src/modules/voucher/schema.ts`'s `promoId` column and regenerate a
   second, small migration for that FK — do this as its own reviewed step, not folded
   into step 4.

**Acceptance criteria**

- Both tables exist with `FORCE ROW LEVEL SECURITY` on.
- Both names present in `APP_TENANT_TABLES`.
- The partial unique index behaves correctly: two rows with `code: null` do not
  conflict; two rows with the same non-null `code` in the same tenant do.
- Migration(s) reviewed, no destructive statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** contracts, service, routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/promo/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/promo/contracts.ts` (new).

**Step-by-step tasks**

1. Write every schema from Pass 2's Contracts section, including both `.refine` checks
   (percentage cap, `endsAt > startsAt`).
2. Export `z.infer` types.

**Acceptance criteria**

- All schemas compile and are importable.
- `createPromoSchema` rejects a percentage over 100 and an `endsAt` at/before `startsAt`.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/promo/contracts.ts`.

---

## Phase 3 — Service + standalone routes + permission gates

**Files to update**

- `apps/chrono-api/src/auth/permissions.ts` — add `promo: ["read", "manage"]` to
  `CHRONO_PERMISSION_STATEMENTS` and `CHRONO_ADMIN_GRANTS`; add only `promo: ["read"]`
  to `CHRONO_STAFF_GRANTS` (the admin+-only split — see Pass 2's reasoning).
- `apps/chrono-api/src/modules/promo/service.ts` (new) — `isWithinWindow`,
  `lockAndValidatePromo`, `computeDiscount`, `redeemPromo` (Pass 2; `redeemPromo` has no
  caller until Phase 4).
- `apps/chrono-api/src/modules/promo/routes.ts` (new) — `promoRoutes()`.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/promos", promoRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — `promo` gate cases, including one
  proving `manage` is denied to `staff` and allowed to `admin`/`owner` (the one real
  staff/admin split in this plan — the case worth proving, per `.ai/rules/testing.md`'s
  "must fail when the permission is removed" requirement).
- `apps/chrono-api/src/modules/promo/service.test.ts` (new) — concurrency test: seed a
  promo with `maxRedemptions: 1`, fire `N` concurrent `redeemPromo` calls, assert exactly
  one succeeds.

**Step-by-step tasks**

1. Add `promo` to `permissions.ts` with the staff/admin split above.
2. Write `service.ts` per Pass 2, with the `SELECT ... FOR UPDATE` +
   `COUNT`-inside-transaction discipline inside `lockAndValidatePromo`.
3. Write `routes.ts`: `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/status`,
   `POST /validate`, all gated via `requirePermission`, mutations inside `withTenant` +
   `recordStaffAudit`.
4. Compose into `rpc.ts`.
5. Add `promo` gate cases to `permissions.test.ts`.
6. Write the `maxRedemptions` concurrency test directly against `service.ts`.

**Acceptance criteria**

- `GET /rpc/promos` returns `{ items, meta }`.
- `POST /rpc/promos` → 403 for `staff`, succeeds for `admin`/`owner`.
- `POST /rpc/promos/validate` correctly reports invalid for an expired/paused/archived/
  below-min-spend/wrong-branch/cap-reached promo, and correctly finds an auto-apply
  promo when no code is given.
- The `maxRedemptions` concurrency test passes deterministically.
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

**Blocked on:** `apps/chrono-api/src/modules/pos/routes.ts` existing, identical
blocker to `vouchers`' own Phase 4. Coordinate landing order with that plan and with
whoever builds `pos`'s own checkout route — Open Question 2 (stacking rules between a
promo and a voucher on the same sale) must be resolved before this phase and `vouchers`'
Phase 4 are both wired in, since they touch the same checkout transaction.

**Files to update (once unblocked)**

- `apps/chrono-api/src/modules/pos/contracts.ts` — add `promoCode: z.string().optional()`
  to `checkoutSchema` (distinct from `vouchers`' `voucherCode` field — resolve Open
  Question 2 on whether both can be present in one request).
- `apps/chrono-api/src/modules/pos/routes.ts` — inside the checkout transaction, after
  the sale row exists: call `lockAndValidatePromo` (with the explicit code if given, or
  no code to check for an auto-apply match) and, if a promo applies, `redeemPromo`,
  adjusting `totalAmount` the same way `vouchers`' Phase 4 describes for its own
  discount.

**Step-by-step tasks**

1. Confirm `pos/routes.ts` exists and read its checkout transaction structure (and
   whether `vouchers`' Phase 4 has already landed in it — if so, this phase composes
   with that code rather than duplicating the total-adjustment logic).
2. Resolve Open Question 2 (stacking) before writing the handler.
3. Add `promoCode` to `checkoutSchema`.
4. Wire `lockAndValidatePromo`/`redeemPromo` into the checkout transaction.
5. Write a route-level concurrency test for `maxRedemptions` under real checkout
   concurrency, not just the service-level one from Phase 3.

**Acceptance criteria**

- A checkout matching an active promo (explicit code or auto-apply) produces a
  `ChronoSale` with the discounted `totalAmount` and a `ChronoPromoRedemptions` row.
- A promo at its per-member or total redemption cap is correctly rejected on the next
  attempt.
- The route-level concurrency test passes deterministically.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pos`'s own test suite, extended with the promo-discount assertions.

**Out of scope:** UI (the checkout screen's own promo-code field is `pos`'s own UI phase
to build; this plan only supplies the `validate` endpoint).

**Execution start point:** re-check `pos/routes.ts` for existence, and coordinate with
`vouchers`' own Phase 4 status, before starting.

---

## Phase 5 — Web UI (standalone campaign management)

**Files to update**

- `apps/chrono-web/src/app/dashboard/promos/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — nav entry + title.

**Step-by-step tasks**

1. Build `page.tsx` per Pass 2's Web UI section, with create/edit actions gated
   visibility-only to `admin`+ via `<Can>`.
2. Build the Create/Edit `Dialog`.
3. Wire `toast.success`/`toast.error`.
4. Add nav entry + title.

**Acceptance criteria**

- `/dashboard/promos` renders, search/sort/paginate/status-filter update the URL.
- A `staff` session sees the list but not the create/edit controls (visibility only —
  the route-level 403 is the real gate).
- Create/edit/pause/archive submit successfully and the list refreshes.
- No raw HTML chrome introduced.

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** the POS checkout screen's promo-code field — `pos`'s own UI phase.

**Execution start point:** create `apps/chrono-web/src/app/dashboard/promos/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/promos/promos.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec covering:
   - **Happy path**: create a promo, confirm it appears `active`; pause it, confirm the
     status updates; archive it, confirm archive is terminal (attempting to reactivate
     fails). (The full checkout-discount happy path belongs in `pos`'s own e2e spec once
     Phase 4 lands.)
   - **Role gate**: a `staff` session cannot create/update/pause/archive a promo (403 or
     hidden controls); `admin`/`owner` can. This is the genuine role-gate case this plan
     has (unlike `reservations`'/`vouchers`' tenant-membership-only framing).
   - **Tenant isolation**: tenant A's promo is invisible from tenant B's list and a
     direct cross-tenant `GET /:id` returns 404.
2. Use `@faker-js/faker` per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three cases pass locally against `pnpm dev`.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/promos/promos.spec.ts`

**Out of scope:** platform-admin coverage; the checkout-discount e2e path (belongs to
`pos`'s own spec once Phase 4 lands).

**Execution start point:** create `apps/chrono-web/e2e/tests/promos/promos.spec.ts`.

---

## Open Questions (developer to confirm/override)

1. **Per-line-item/category targeting** — this plan discounts the whole sale subtotal
   only. Confirm this MVP scope, or specify a targeting-rule shape if wanted sooner.
2. **Stacking rules between a promo and a voucher on the same sale** — genuinely
   undecided; this plan's proposed Phase 4 default is "at most one discount per sale."
   Confirm before Phase 4 (this plan) and `vouchers`' Phase 4 are both implemented,
   since they share the same checkout transaction.
3. **Bulk-minting vouchers from a promo campaign** — deferred to `vouchers`' own Out of
   Scope; confirm which module should eventually own it if wanted.
4. **A customer-facing "browse active promos" portal view** — not built; same standing
   open question as every Wave 2 module.
5. **Tenant-configurable redemption-cap defaults** — `maxRedemptionsPerMember` defaults
   to `1` at the DB layer; confirm that default, or make it tenant-configurable.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/promos/` to
`.ai/plans/chrono/archive/promos/` once all six phases are verified and committed
separately (Phase 4 is blocked and may land later — don't hold the other phases hostage
to it, and coordinate its landing with `vouchers`' own Phase 4 per Open Question 2).
Update `.ai/handover/chrono-migration.md`'s Plan status table.
