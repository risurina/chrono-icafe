# Chrono — `loyalty` module

**Depends on:** `members` (implemented — `tenantMember` is the identity anchor, per the
ratified cross-cutting decision) and, for its automatic earn-from-spend behavior,
`wallet` and `pos`. **Both of those dependencies are partial today**: `wallet` has only
`schema.ts` + `contracts.ts` + `money.ts` on disk — no `service.ts`/`routes.ts`, so there
is no live credit/debit endpoint to hook into yet. `pos` has only `schema.ts` +
`contracts.ts` — no `service.ts`/`routes.ts`, so there is no live checkout endpoint
either. This is a real, structural blocker for the "earn points automatically when a
customer spends" workflow, not a paperwork gap — see Phase 4. This plan ships everything
that does **not** need those routes to exist (schema, contracts, manual staff earn/
redeem, balance/history reads, tiers) now, and gates only the automatic-earn hook on
`wallet`'s and `pos`'s own routes landing.

## What this is

A loyalty account per customer (`tenantMember`) that accumulates points from spend and
lets staff redeem points manually today (a reward catalog is a deliberate follow-up, not
this pass — see Out of Scope). Points roll up into a tier (bronze/silver/gold/platinum)
staff can see at the counter. This is Chrono's retention mechanic — the thing that turns
a one-off walk-in into a repeat customer.

## Prior art and where this plan diverges from it

Read at `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/database/schema/loyalty.ts`
+ `src/modules/loyalty/{service,routes,dto}.ts`. oikos's loyalty module is real but
**structurally weak in ways this plan does not carry forward**:

1. **No automatic earning exists at all** — oikos's only way to gain points is a staff
   member calling `POST /loyalty/earn` by hand. There is no hook anywhere in its
   `wallet`/`pos` modules that calls `earnPoints`. For a retention mechanic, this is a
   design gap, not a deliberate simplicity choice — nothing in the product actually
   rewards a customer for spending unless a staffer remembers to type in the points
   manually every time. **This plan builds the real thing**: a `earnLoyaltyPoints`
   service function callable from inside the same transaction as a wallet top-up or a
   completed POS sale (Phase 4) — deferred only because those callers don't exist yet as
   routes, not because auto-earn is out of scope.
2. **`redeemPoints` has a genuine TOCTOU race.** It calls `getOrCreateLoyaltyRecord`
   (a plain `SELECT`), computes `balanceAfter` in application code, then does a bare
   `UPDATE ... WHERE id = record.id` with no `SELECT ... FOR UPDATE` and no
   `WHERE balance = balanceBefore` guard. Two concurrent redemptions against the same
   account can both read the same starting balance and both succeed, over-redeeming the
   account into a state the `balanceAfter < 0` check never catches for the second
   writer. This plan uses the identical `SELECT ... FOR UPDATE`-then-write discipline
   `wallet`/`pos`/`reservation` already established — a correctness fix, not a
   preference.
3. **"Tier" is decorative, not real.** `listLoyaltyAccounts` computes a tier
   (bronze/silver/gold/platinum, hardcoded thresholds) inline, in one read-only listing
   route, and nowhere else — it is never stored, never returned from the member-facing
   `/balance` endpoint, and gates no benefit (no discount multiplier, no perk). It exists
   only so the staff list page has a column to show. This plan makes tier a **persisted,
   recomputed-on-every-earn** column on the account row (Phase 1's `tier`) so it is an
   actual account attribute any route can read cheaply — still no tier *benefits* in this
   pass (see Open Question 2), but the tier itself is now real state, not a throwaway
   list-view computation.
4. **Unstructured `metadataJson` catch-all** (`Record<string, any>`) on both
   `LoyaltyPointTransaction` and `MembershipCard`. This plan does not carry that forward
   — `referenceType`/`referenceId` (typed, like `wallet`'s ledger) are enough to trace
   what caused a transaction; an untyped jsonb bag is a place bugs hide, not a feature.
5. **`MembershipCard` (RFID card issuance/replacement) is out of scope for this plan** —
   it is a physical-card/kiosk-hardware feature that depends on `devices`, which doesn't
   exist in Chrono-on-Agora yet. Not dropped for being weak; genuinely blocked on a
   dependency this plan doesn't have, same reasoning `reservations` used to defer oikos's
   queue/hold system.
6. **oikos's `User` identity split** (loyalty rows reference a bare `User` table, and
   `routes.ts`'s own comment admits "Chrono players are not Oikos tenant members" —
   i.e. oikos forked a second identity concept for loyalty). This is exactly the mistake
   `.ai/rules/business-app.md`'s ratified cross-cutting decision already exists to
   prevent. This plan anchors every row to `tenantMember` directly — no parallel
   identity, no fork.

Where this plan **does** match oikos, it says so explicitly (the tier threshold numbers
below, kept only because they're a reasonable default with no reason to invent new ones).

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff/Admin/Owner** — see a customer's points balance and tier at the counter, credit
  points manually (a goodwill gesture, an in-person event bonus), and correct a wrong
  balance (`loyalty:adjust`, see Permission vocabulary — a self-service redemption
  reward catalog is out of scope, so "redeem" in this pass is also staff-driven: a
  customer asks to cash in points for something off-menu, staff records the redemption).
- **Customer (portal)** — **not built in this pass**, same open question every prior
  Wave 2 module has flagged (`reservations` Open Question 1): no Chrono-specific portal
  page exists yet. A customer cannot see their own balance/history without asking staff.
- **Platform admin (`/rpc-admin`)** — not built, same as every prior module.

**Workflow:** A customer completes a POS sale or tops up their wallet — once Phase 4
lands, their loyalty account is credited automatically (points = spend × the
tenant's earn rate, rounded down to a whole point) with no staff action. Until Phase 4
lands (or if the developer wants to earn manually regardless), staff open **Dashboard →
Loyalty**, find the customer, and click **Adjust** to credit or redeem points by hand,
recording a reason. The account's tier badge updates immediately after any earn that
crosses a threshold.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()`.
- A caller without `loyalty:manage` attempting a manual earn/redeem/adjust → 403.
- **Redeeming more points than the balance holds** → 409, checked under
  `SELECT ... FOR UPDATE` inside the mutating transaction (see "diverges from oikos" #2
  above — this is the module's one load-bearing correctness mechanism, same class of
  guard `wallet`'s balance check and `pos`'s stock check both use).
- A `memberId` that doesn't belong to the caller's tenant → 404, never 403 (no existence
  leak), looked up inside the same `withTenant` transaction.
- **Tenant-isolation leak scenario**: tenant A's customer's loyalty account/history must
  never be visible from tenant B's session, even via a guessed account id (404).
- Two staff adjusting the same account concurrently — the row lock inside the mutation
  transaction is what makes the actual point mutation safe; the read-only list view has
  no staleness guard beyond "reload to see the latest," matching every prior module's
  framing.

**Audit / notifications:** every earn/redeem/adjustment writes a `recordStaffAudit` entry
(`chronoLoyalty.earned` / `.redeemed` / `.adjusted`), capturing the account, the points
delta, and the reason — same "an amount belongs in the audit entry" principle `wallet`
established. No email/SMS notification on tier-up in this pass — trivial follow-up, not
required to ship.

---

## Pass 2 — Technical Planning

### Pattern to copy

- `apps/chrono-api/src/modules/wallet/schema.ts` — the account-row +
  append-only-ledger-row shape (`chronoWallet`/`chronoWalletTransaction`), the
  `balanceBefore`/`balanceAfter` self-checking-ledger convention, and the
  `referenceType`/`referenceId` polymorphic-but-typed reference-column pattern. This
  plan's `ChronoLoyaltyAccounts`/`ChronoLoyaltyTransactions` mirror that shape exactly,
  substituting `points` for money.
- `apps/chrono-api/src/modules/wallet/contracts.ts` — the money-amount regex pattern;
  this plan uses a plain positive-integer schema instead (points are always whole
  numbers, matching oikos's own `integer` column choice — one thing oikos got right).
- `apps/chrono-api/src/modules/reservation/service.ts` — the
  `SELECT ... FOR UPDATE`-then-validate-then-write pattern this plan's `redeemPoints`/
  `adjustPoints` follow (see "diverges from oikos" #2).
- `.ai/rules/business-app.md` — module folder: `apps/chrono-api/src/modules/loyalty/`
  (`schema.ts`, `contracts.ts`, `service.ts`, `routes.ts`).
- `apps/chrono-api/src/auth/permissions.ts` +
  `apps/chrono-api/src/auth/require-permission.ts` — this plan adds `loyalty` via the
  per-app permission-extension seam, exactly like `reservation` did. **Never** edit
  `packages/agora/src/auth/permissions.ts` directly.

### Schema — `apps/chrono-api/src/modules/loyalty/schema.ts`

```ts
import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoLoyaltyAccount = pgTable(
  "ChronoLoyaltyAccounts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // One loyalty account per tenantMember — enforced by the unique index below,
    // identical shape to ChronoWallets.memberId.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    pointsBalance: integer("pointsBalance").notNull().default(0),
    // Never decreases on redemption — the tier is computed off lifetime earnings,
    // not current balance, so redeeming points never demotes a customer's tier.
    // (oikos has no lifetime/tier persistence at all — see Pass 2's diverges list.)
    lifetimePoints: integer("lifetimePoints").notNull().default(0),
    // "bronze" | "silver" | "gold" | "platinum" — recomputed from lifetimePoints on
    // every earn inside the same transaction (service.ts), never client-set.
    tier: text("tier").notNull().default("bronze"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_loyalty_account_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_loyalty_account_member_uq").on(t.memberId),
    index("chrono_loyalty_account_tier_idx").on(t.tier),
  ],
);

export const chronoLoyaltyTransaction = pgTable(
  "ChronoLoyaltyTransactions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    accountId: text("accountId")
      .notNull()
      .references(() => chronoLoyaltyAccount.id, { onDelete: "cascade" }),
    // Denormalized alongside accountId (mirrors ChronoWalletTransactions.memberId)
    // so a member's history reads without a join.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "earn" | "redeem" | "adjustment"
    // Signed delta: positive = balance increased, negative = decreased.
    points: integer("points").notNull(),
    balanceBefore: integer("balanceBefore").notNull(),
    balanceAfter: integer("balanceAfter").notNull(),
    reason: text("reason").notNull(),
    // "wallet_transaction" | "pos_sale" | "manual" — set once Phase 4 wires the
    // auto-earn hooks; "manual" for every row this plan's own Phase 3 can produce.
    referenceType: text("referenceType"),
    // Polymorphic, deliberately not a real FK — the identical reasoning
    // ChronoWalletTransactions.referenceId already uses (the referent's table
    // varies by referenceType and some of them, e.g. a future pos sale id, are
    // typed elsewhere already).
    referenceId: text("referenceId"),
    // Null for an automatic earn (no staff actor). Non-null for every manual
    // earn/redeem/adjustment this plan's Phase 3 routes produce.
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Immutable ledger row — no updatedAt, mirrors ChronoWalletTransactions exactly.
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_loyalty_transaction_tenant_idx").on(t.tenantId),
    index("chrono_loyalty_transaction_account_idx").on(t.accountId),
    index("chrono_loyalty_transaction_member_idx").on(t.memberId),
    index("chrono_loyalty_transaction_type_idx").on(t.type),
    index("chrono_loyalty_transaction_created_idx").on(t.createdAt),
  ],
);

export type NewChronoLoyaltyAccount = typeof chronoLoyaltyAccount.$inferInsert;
export type ChronoLoyaltyAccountRow = typeof chronoLoyaltyAccount.$inferSelect;
export type NewChronoLoyaltyTransaction = typeof chronoLoyaltyTransaction.$inferInsert;
export type ChronoLoyaltyTransactionRow = typeof chronoLoyaltyTransaction.$inferSelect;
```

Add `"ChronoLoyaltyAccounts"` and `"ChronoLoyaltyTransactions"` to `APP_TENANT_TABLES` in
`apps/chrono-api/src/db/schema.ts`, importing/re-exporting both tables mirroring the
existing `chronoWallet`/`chronoWalletTransaction` re-export style. Check the file's
current state first — `vouchers`/`promos` are landing in the same window (see the
handover once all three plans are committed).

### Tier thresholds (kept from oikos, now actually enforced)

```ts
// apps/chrono-api/src/modules/loyalty/service.ts
export const LOYALTY_TIERS = [
  { key: "platinum", minLifetimePoints: 5000 },
  { key: "gold", minLifetimePoints: 3000 },
  { key: "silver", minLifetimePoints: 1000 },
  { key: "bronze", minLifetimePoints: 0 },
] as const;
```

These four thresholds are oikos's own numbers — kept because they're a reasonable
starting default with no evidence a different number is better, not because everything
else about oikos's tier handling is worth keeping (see diverges list #3). **Open
Question 1** asks whether these should be tenant-configurable from day one.

### Earn rate

```ts
// apps/chrono-api/src/modules/loyalty/service.ts
export const LOYALTY_POINTS_PER_CURRENCY_UNIT = 1; // 1 point per whole currency unit spent
```

A code constant for this pass, applied by whichever caller invokes
`earnLoyaltyPoints` with a spend amount (Phase 4). **Open Question 3** flags whether this
should be tenant-configurable (a `platform_setting`-style per-tenant override) before
Phase 4 ships, or whether a single code constant is fine for the MVP.

### Service — `apps/chrono-api/src/modules/loyalty/service.ts`

```ts
async function getOrCreateAccount(tx: TenantTx, tenantId: string, memberId: string): Promise<ChronoLoyaltyAccountRow> { /* SELECT, else INSERT with defaults */ }

function tierFor(lifetimePoints: number): string { /* first LOYALTY_TIERS entry whose minLifetimePoints <= lifetimePoints */ }

/**
 * Locks the account row (SELECT ... FOR UPDATE), applies a signed points delta,
 * recomputes tier from the new lifetimePoints (earn only — redeem/adjustment-down
 * never changes lifetimePoints, matching the "tier never demotes on spend" design
 * decision above), writes the ledger row, and returns the updated account.
 * Throws HttpError(409, ...) if a redeem/negative-adjustment would take
 * pointsBalance below zero.
 */
async function applyPointsDelta(tx: TenantTx, args: {
  tenantId: string; memberId: string; type: "earn" | "redeem" | "adjustment";
  points: number; reason: string; referenceType?: string; referenceId?: string;
  performedByUserId?: string;
}): Promise<ChronoLoyaltyAccountRow> { /* ... */ }

/** The Phase-4 integration point — called from inside wallet's/pos's own
 * transaction once those modules have routes to call it from. */
export async function earnLoyaltyPoints(tx: TenantTx, args: {
  tenantId: string; memberId: string; spendAmount: string /* decimal string */;
  referenceType: "wallet_transaction" | "pos_sale"; referenceId: string;
}): Promise<void> { /* points = floor(Number(spendAmount) * LOYALTY_POINTS_PER_CURRENCY_UNIT); applyPointsDelta(..., type: "earn", performedByUserId: undefined) */ }
```

### Routes — `apps/chrono-api/src/modules/loyalty/routes.ts`

A Hono factory `loyaltyRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/loyalty", loyaltyRoutes())`:

- `GET /accounts` — `loyalty:read`. Paginated (`listQuerySchema`), searchable by member
  name/email (join `base.tenantMember`), filterable by `tier`. `{ items, meta }`.
- `GET /accounts/:memberId` — `loyalty:read`. 404 cross-tenant or unknown member.
  Auto-creates the account row lazily on first read is **not** done here (mirrors
  oikos's own "reads never create" comment, which is genuinely correct — a member read
  must not conjure a row for a member who has never earned anything); returns a
  zero-balance/`"bronze"` synthesized shape instead when no row exists.
- `GET /accounts/:memberId/transactions` — `loyalty:read`. Paginated ledger for one
  member.
- `POST /accounts/:memberId/earn` — `loyalty:manage`. Body: `{ points: number, reason:
  string }`. Calls `applyPointsDelta(..., type: "earn", performedByUserId: caller)`.
  `recordStaffAudit("chronoLoyalty.earned", ...)`.
- `POST /accounts/:memberId/redeem` — `loyalty:manage`. Body: `{ points: number, reason:
  string }`. 409 if insufficient balance. `recordStaffAudit("chronoLoyalty.redeemed",
  ...)`.
- `POST /accounts/:memberId/adjust` — `loyalty:adjust` (see Permission vocabulary — a
  distinct, more restricted action than `earn`/`redeem`, mirroring `wallet:adjust`).
  Body: `{ delta: number (signed, nonzero), reason: string }`. `recordStaffAudit(
  "chronoLoyalty.adjusted", ...)`.

No `DELETE` — an account is never deleted while it has ledger history, matching every
prior module's "immutable audit trail" precedent (cascades only via the member's own
deletion, per `onDelete: "cascade"` above).

### Permission vocabulary

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  loyalty: ["read", "manage", "adjust"],
} satisfies Record<string, string[]>;
```

- `staffRole` grant — `loyalty: ["read", "manage"]`. Earning/redeeming points for a
  customer at the counter is routine front-desk work, the same tier `reservation`'s
  `manage` and `wallet`'s `credit`/`debit` already established for staff-run
  customer-facing operations.
- `adminRole` grant — `loyalty: ["read", "manage", "adjust"]`. `adjust` (a raw,
  signed balance correction with no earn/redeem semantics) is admin+-only, mirroring
  `wallet:adjust`'s exact reasoning: a correction tool for when the ledger is wrong,
  not a counter operation, so it warrants a narrower tier than `earn`/`redeem`.
  `ownerRole` needs no explicit grant — it receives every registered resource in full.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List accounts | `GET /rpc/loyalty/accounts` | `loyalty:read` | paginated, searchable, filterable by tier |
| Detail | `GET /rpc/loyalty/accounts/:memberId` | `loyalty:read` | synthesized zero-state if no row exists; 404 cross-tenant/unknown member |
| History | `GET /rpc/loyalty/accounts/:memberId/transactions` | `loyalty:read` | paginated ledger |
| Earn | `POST /rpc/loyalty/accounts/:memberId/earn` | `loyalty:manage` | staff-tier |
| Redeem | `POST /rpc/loyalty/accounts/:memberId/redeem` | `loyalty:manage` | 409 insufficient balance |
| Adjust | `POST /rpc/loyalty/accounts/:memberId/adjust` | `loyalty:adjust` | admin+-only, signed delta |
| Delete | — | — | not built — accounts/ledger are permanent |

Feedback: `toast.success`/`toast.error` at the point of the API call, surfacing the 409
insufficient-balance message verbatim, matching `wallet`'s convention.

Audit linkage: `recordStaffAudit` on every mutation, capturing the account, the points
delta, and the reason.

### Web UI

- **`apps/chrono-web/src/app/dashboard/loyalty/page.tsx` (new)**: `DataTable` of
  accounts (member name, balance, tier badge, last activity), `useListQuery()` for
  URL-driven search/sort/pagination, a tier filter chip row.
- A per-account **Adjust** `Dialog`: action `Select` (Earn / Redeem / Adjust — only
  `Adjust` requires `loyalty:adjust`, hide it via `<Can>` for staff), points `Input`,
  reason `Textarea`. Submits via `api.rpc.loyalty.accounts[":memberId"][action].$post`.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add `Loyalty` to `BASE_NAV` (a
  `Star`-style `lucide-react` icon) and `"/dashboard/loyalty": "Loyalty"` to `TITLES`.
- No module-registry feature-flag gate in this pass, matching every prior module's
  default (confirm with the developer if a kill-switch is wanted).

### Out of Scope (this plan)

- **A customer-facing self-service loyalty view/redemption catalog** — Open Question 4.
  No portal exists yet for any Chrono module; this is a new surface, not a small
  addition.
- **Automatic earn from wallet top-ups / POS sales** (Phase 4) — ships once `wallet`'s
  and `pos`'s own routes land; this plan's own routes are fully usable without it.
- **A reward catalog** (redeem points for a specific product/discount, not a plain
  point deduction) — genuinely new scope beyond oikos's own model, not built here; see
  Open Question 2.
- **`MembershipCard` (RFID card issuance)** — needs `devices`, not implemented yet.
- **Tenant-configurable tier thresholds / earn rate** — code constants in this pass; see
  Open Questions 1 and 3.
- **Points expiry** — oikos has none either (no sweep job, no `expiresAt`); not invented
  here.
- **The `/rpc-admin` platform-admin cross-tenant view** — no
  `PLATFORM_PERMISSION_STATEMENTS` resource exists for this today.
- Module-registry (`modules.loyalty`) feature-flag gating of the nav entry.
- Any `wallet`/`pos` route code — separate, unrelated plans; this plan only calls
  `earnLoyaltyPoints` from inside them once they exist.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/loyalty/schema.ts` (new) — both tables (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export, add
  `"ChronoLoyaltyAccounts"`/`"ChronoLoyaltyTransactions"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/loyalty/` and write `schema.ts` exactly as
   specified in Pass 2.
2. In `apps/chrono-api/src/db/schema.ts`, add the import/re-export and append both
   table names to `APP_TENANT_TABLES` — check the file's current state first, since
   `vouchers`/`promos` may be landing in the same window.
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_loyalty` (never
   `db:push`). Review the generated SQL: two `CREATE TABLE` statements, five/six
   indexes total, three FKs, no destructive statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- Both tables exist with `FORCE ROW LEVEL SECURITY` on.
- Both names are present in `APP_TENANT_TABLES`.
- Migration reviewed, no destructive statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, service, routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/loyalty/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/loyalty/contracts.ts` (new).

**Step-by-step tasks**

1. Write `loyaltyTransactionTypeSchema` (`z.enum(["earn", "redeem", "adjustment"])`),
   `earnPointsSchema` (`{ points: z.number().int().positive().max(1_000_000), reason:
   z.string().min(1).max(255) }`), `redeemPointsSchema` (same shape), `adjustPointsSchema`
   (`{ delta: z.number().int().refine(v => v !== 0), reason: z.string().min(1).max(255) }`),
   and `loyaltyAccountListQuerySchema` (`listQuerySchema(["pointsBalance", "createdAt"])`
   extended with `tier`/`search` filters).
2. Export `z.infer` types for each.

**Acceptance criteria**

- All schemas compile and are importable.
- `earnPointsSchema`/`redeemPointsSchema` reject zero/negative points; `adjustPointsSchema`
  rejects a zero delta.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create
`apps/chrono-api/src/modules/loyalty/contracts.ts`.

---

## Phase 3 — Service + routes + permission gates (manual earn/redeem/adjust)

**Files to update**

- `apps/chrono-api/src/auth/permissions.ts` — add `loyalty: ["read", "manage",
  "adjust"]` to `CHRONO_PERMISSION_STATEMENTS`, `CHRONO_STAFF_GRANTS` (`read`/`manage`
  only), `CHRONO_ADMIN_GRANTS` (all three).
- `apps/chrono-api/src/modules/loyalty/service.ts` (new) — `getOrCreateAccount`,
  `tierFor`, `applyPointsDelta`, `earnLoyaltyPoints` (Pass 2; `earnLoyaltyPoints` is
  written now but has no caller until Phase 4).
- `apps/chrono-api/src/modules/loyalty/routes.ts` (new) — `loyaltyRoutes()` factory.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/loyalty", loyaltyRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `loyalty` gate cases, including
  one proving `adjust` is denied to `staff` and allowed to `admin`/`owner` (a gate test
  must fail when the permission is removed from the role, per `.ai/rules/testing.md` —
  this is the one real staff/admin split in this plan, so it is the case worth proving).
- `apps/chrono-api/src/modules/loyalty/service.test.ts` (new) — the concurrency test for
  `applyPointsDelta` (mirrors `wallet`'s own balance-race test, if one exists, or
  `reservation`'s `overlap.test.ts` structure otherwise): `N` concurrent redemptions
  against an account with exactly enough balance for one → assert exactly one succeeds.

**Step-by-step tasks**

1. Add the `loyalty` resource to `permissions.ts` exactly as specified above.
2. Write `service.ts` per Pass 2, with the `SELECT ... FOR UPDATE`-then-write discipline
   inside `applyPointsDelta` (the fix for oikos's TOCTOU race).
3. Write `routes.ts`: the five routes from Pass 2's Routes section, each gated via
   `requirePermission` from `apps/chrono-api/src/auth/require-permission.ts`, all
   mutations inside `withTenant` + `recordStaffAudit`. Follow the structural conventions
   of `apps/chrono-api/src/modules/wallet/` once its own routes exist, or
   `reservation/routes.ts` otherwise (whichever is more complete on disk at
   implementation time).
4. Compose into `rpc.ts`.
5. Add `loyalty` gate cases to `permissions.test.ts`.
6. Write the concurrency test for `applyPointsDelta`.

**Acceptance criteria**

- `GET /rpc/loyalty/accounts` returns `{ items, meta }`.
- `POST .../redeem` on an account with insufficient balance → 409; two concurrent
  redemptions racing the exact remaining balance → exactly one succeeds.
- `POST .../adjust` → 403 for `staff`, succeeds for `admin`/`owner`.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new cases.
- The concurrency test passes deterministically across repeated runs.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test` (loyalty's concurrency test)

**Out of scope:** the auto-earn hooks (Phase 4), UI, e2e.

**Execution start point:** edit `apps/chrono-api/src/auth/permissions.ts` first.

---

## Phase 4 — Auto-earn integration with `wallet` and `pos` (BLOCKED)

**Blocked on:** `apps/chrono-api/src/modules/wallet/routes.ts` and
`apps/chrono-api/src/modules/pos/routes.ts` both existing — neither does today (both
modules currently have `schema.ts`/`contracts.ts` only). This phase amends those two
files once they land; it cannot be written against code that doesn't exist yet.

**Files to update (once unblocked)**

- `apps/chrono-api/src/modules/wallet/routes.ts` — after a successful credit, call
  `earnLoyaltyPoints(tx, { tenantId, memberId, spendAmount: amount, referenceType:
  "wallet_transaction", referenceId: walletTransaction.id })` inside the same
  transaction as the credit itself (not a separate follow-up call — if the wallet credit
  and the loyalty earn aren't atomic, a crash between them silently drops points, the
  exact bug class `.ai/rules/database.md`'s "keep mutations that must stay consistent in
  a single transaction" rule exists to prevent).
- `apps/chrono-api/src/modules/pos/routes.ts` — after a completed checkout, call the
  same function with `referenceType: "pos_sale"`, `spendAmount: sale.totalAmount`,
  inside the checkout's own transaction.

**Step-by-step tasks**

1. Confirm both target files exist and read their current transaction structure before
   editing — do not guess at their shape.
2. Add the `earnLoyaltyPoints` call inside each transaction, immediately after the
   value that determines `spendAmount` is known and committed to the row.
3. Decide (with the developer) whether a *debit* (wallet debit, a refund) should also
   emit a symmetric point *reversal* — oikos never modeled this either way; **Open
   Question 5**.

**Acceptance criteria**

- A wallet top-up and a completed POS sale each produce exactly one `"earn"` loyalty
  transaction with the correct `referenceType`/`referenceId`, inside the same DB
  transaction as the triggering mutation (verified by forcing a rollback mid-transaction
  in a test and confirming no orphaned loyalty row).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- Whatever test suite covers `wallet`'s and `pos`'s own checkout/credit transactions —
  extend it with the loyalty-earn assertion rather than writing a fully separate suite.

**Out of scope:** UI changes (Phase 5 already surfaces the resulting balance).

**Execution start point:** re-check `wallet/routes.ts` and `pos/routes.ts` for
existence before starting; if still absent, this phase stays blocked.

---

## Phase 5 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/loyalty/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — nav entry + title.

**Step-by-step tasks**

1. Build `page.tsx` per Pass 2's Web UI section: `DataTable` + `useListQuery()`, tier
   filter chips, per-row **Adjust** action opening the earn/redeem/adjust `Dialog`.
2. Gate the `Adjust` action's UI visibility on `loyalty:adjust` via `<Can>` (visibility
   only — the route is the real gate).
3. Wire `toast.success`/`toast.error`, surfacing the 409 message verbatim.
4. Add the nav entry + title to `dashboard/layout.tsx`.

**Acceptance criteria**

- `/dashboard/loyalty` renders, search/sort/paginate/tier-filter update the URL.
- Earn/redeem/adjust submit successfully and the row refreshes.
- A staff session never sees the Adjust-specific action exposed (visibility check),
  though the real 403 is still the enforcement (per `.ai/rules/rbac.md`).
- No raw HTML chrome introduced (`component-first-ui.md` check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** customer-facing portal view (Open Question 4).

**Execution start point:** create `apps/chrono-web/src/app/dashboard/loyalty/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/loyalty/loyalty.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec covering:
   - **Happy path**: sign up a tenant, create a member, navigate to
     `/dashboard/loyalty`, earn points, redeem some, confirm the balance/tier updates.
   - **Role gate**: a `staff` session cannot see/use the Adjust action's admin-only
     path (or gets 403 attempting the underlying request directly); `admin`/`owner`
     can.
   - **Tenant isolation**: tenant A's loyalty account is invisible from tenant B's
     dashboard and a direct `GET /rpc/loyalty/accounts/:memberId` cross-tenant returns
     404.
2. Use `@faker-js/faker` per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three cases pass locally against `pnpm dev`.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/loyalty/loyalty.spec.ts`

**Out of scope:** platform-admin coverage; the Phase 4 auto-earn path (covered by
Phase 4's own backend test, not an e2e concern once wired).

**Execution start point:** create
`apps/chrono-web/e2e/tests/loyalty/loyalty.spec.ts`.

---

## Open Questions (developer to confirm/override)

1. **Tenant-configurable tier thresholds** — this plan ships code-defined thresholds
   (oikos's own numbers, kept as a reasonable default). Confirm code-defined is fine for
   the MVP, or specify a per-tenant override surface (a new, small settings table) if
   wanted sooner.
2. **Reward catalog** — this plan's "redeem" is a plain points deduction with a reason,
   not a catalog of redeemable rewards/discounts. A catalog is a materially bigger
   feature (its own table, its own POS-checkout-discount interaction — likely
   overlapping with `promos`' discount-application machinery). Confirm this MVP scope is
   acceptable.
3. **Tenant-configurable earn rate** — a single code constant (`1 point per currency
   unit`) in this pass. Confirm, or specify a per-tenant override before Phase 4.
4. **Customer-facing self-service view** — not built (same shape as `reservations`'
   Open Question 1). Confirm deferral, or scope a small `/portal/loyalty` page as a
   follow-up.
5. **Point reversal on a wallet debit/refund** — Phase 4 does not build a symmetric
   "claw back points on refund" path (oikos has no such logic either). Confirm this is
   acceptable, or specify the reversal rule once `wallet`/`pos` refund flows exist.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/loyalty/` to
`.ai/plans/chrono/archive/loyalty/` once all six phases are verified and committed
separately (Phase 4 may land much later than the others, given its blocked status —
don't hold Phases 1–3/5–6 hostage to it; archive note can record Phase 4 as
"landed later" the way `sessions`' realtime follow-up was tracked). Update
`.ai/handover/chrono-migration.md`'s Plan status table.
