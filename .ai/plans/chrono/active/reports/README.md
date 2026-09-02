# Chrono — `reports` module

**Depends on:** `pos` (schema landed — `ChronoProducts`/`ChronoSales`/`ChronoSaleItems`/
`ChronoSalePayments` exist on disk; routes not yet built, so these tables are empty in
practice until `pos`'s own route phase ships — this plan's queries are correct against
the schema regardless, they just have nothing to aggregate until `pos` routes land),
`wallet` (schema landed — `ChronoWallets`/`ChronoWalletTransactions` exist), `shift`
(schema + routes landed — `ChronoShifts` exists and is populated by real open/close
traffic today). **No hard dependency on `reconciliation`** — this plan reads
`ChronoShifts.expectedCashAmount`/`differenceAmount` wherever they're populated, but
does not require the `reconciliation` plan to have landed first; those two columns just
render `null`/"—" until it does, exactly the way `shifts`' own UI already handles them.
**No new tables.** This module is entirely new read-only `/rpc` routes plus a dashboard
UI — see "Critical scope finding" below.

## What this is

Read-heavy analytics over data Chrono already collects: sales revenue and product mix
from `pos`, wallet credit/debit volume from `wallet`, and shift cash accountability from
`shift`. Staff and admins get a dashboard (KPI tiles + trend charts) and a small set of
drill-down list/table views, all server-aggregated and tenant-scoped — nothing here
writes anything.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff** — sees an operational, branch-scoped view: today's sales total and count,
  the day's shift list with cash status, product mix for their own branch. Nothing here
  is a financial-control action; it's the same "front desk needs to see what's
  happening" posture `shifts`' own list route already takes (ungated read, no staff/admin
  split on the underlying resource).
- **Admin / Owner** — additionally sees tenant-wide, cross-branch rollups: revenue trend
  over time, wallet inflow/outflow totals, per-branch comparison. This is the one real
  split in this plan — see Permission vocabulary — because a cross-branch revenue rollup
  is competitively/financially sensitive in a multi-branch tenant in a way a single
  branch's own today-numbers are not (mirrors `wallet`'s `credit`/`debit` (staff) vs.
  `adjust` (admin+) reasoning, applied to "see my branch" vs. "see the whole business").
- **Customer (portal)** — not applicable; this is a staff/admin analytics surface.
- **Platform admin (`/rpc-admin`)** — not built in this pass. The existing
  `/rpc-admin/usage` cross-tenant surface (`.ai/rules/rbac.md`) is unrelated — that's
  platform-operator usage metering, not a tenant's own business analytics.

**Workflow:** Staff opens **Dashboard → Reports** and lands on an overview: today's sales
total/count (a `Sparkline` against the last 14 days), the day's shifts with their
open/closed status and cash variance where known, and a simple product-category
breakdown for the selected branch. An owner switches the date range (last 7/30/90 days,
or a custom range) and sees a `TrendChart` of daily revenue across all branches, plus a
wallet activity summary (total credited vs. debited in the period). Every view is
read-only — there is no "export" or "email this report" action in this pass (see Out of
Scope).

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Staff requesting the tenant-wide financial rollup route → 403, gated by
  `requirePermission(..., { report: ["readFinancial"] })`.
- An invalid/inverted date range (`to` before `from`, or a range exceeding a sane cap —
  this plan proposes 366 days) → **400** (Zod-level cross-field check).
- A `branchId` filter that doesn't belong to the caller's tenant → **404**, looked up
  inside the same `withTenant` read before being used, same discipline as every prior
  module.
- **Tenant-isolation leak scenario**: tenant A's daily revenue must never appear in
  tenant B's dashboard even if both happen to have sales on the same calendar day — every
  aggregation query is scoped through `withTenant(tenantId, ...)`, never a bare
  cross-tenant scan.
- Empty-state: a brand-new tenant with zero sales/shifts/wallet activity sees zeroed
  tiles and an empty-state chart, not an error — every aggregate query must tolerate
  `NULL`/no-rows (`COALESCE(..., 0)`), the same class of bug `rls:proof`'s own
  "non-vacuous" check exists to catch in a different context.
- Stale screen: dashboards poll/refetch on a manual refresh or route revisit only — no
  live-push in this pass (agora has no realtime infrastructure yet, per
  `.ai/handover/chrono-migration.md`'s `chrono-realtime-updates` note).

**Audit / notifications:** none. Every route in this module is a `GET`; per
`.ai/rules/rbac.md`'s own precedent (`audit`, `systemHealth` — read-only resources write
no audit rows), a pure read surface does not call `recordStaffAudit`.

---

## Pass 2 — Technical Planning

### Divergence from oikos — role scope and attribution reliability

Research against `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/modules/
reports/` (`service.ts`, `cashier.service.ts`, `revenue.service.ts`) found two design
choices this plan deliberately does not carry forward:

1. **oikos gates almost every report route `requireRole(['OWNER'])` outright** — even
   `/owner-live`, a same-branch today's-revenue tile a shift-working staff member has
   every reason to see. That's a stricter default than this product needs and worse for
   the "staff needs to see what's happening at the counter" workflow this plan's Pass 1
   describes. **This plan diverges**: `report:read` (staff+) covers the operational,
   branch-scoped views; only the unscoped cross-branch rollup and wallet-activity report
   require `report:readFinancial` (admin+) — a narrower elevation than oikos's
   blanket owner-only gate, scoped to what's actually sensitive (see Permission
   vocabulary below).
2. **oikos's `cashier.service.ts` attributes payments to a shift by a `branch +
   [openedAt, closedAt]` time-window join**, with its own code comment admitting
   `Payment.shiftId` "is NOT reliably populated" and a payment falling outside every
   shift interval lands in an `unattributed` bucket rather than being dropped — a fragile
   heuristic working around an unreliable write path, not a deliberate design. **This
   plan diverges**: `shift-summary`'s figures come from `ChronoShifts` rows directly
   (its own `expectedCashAmount`/`differenceAmount`/`actualCashAmount` columns, populated
   reliably by the `reconciliation` plan's `shiftId`-exact attribution — see that plan's
   own "Design weaknesses found in oikos" section for the full reasoning) rather than
   re-deriving shift cash totals from a second, independent time-window join in this
   module. `reports` reads what `reconciliation` already computed; it does not
   reimplement that computation with a weaker join.

### Critical scope finding — this is a read/aggregation layer, not a new domain

Unlike every Wave 1/2 module so far, `reports` owns no table of its own. Its entire job
is `SELECT ... GROUP BY` over three other modules' existing tenant-scoped tables. That
has one concrete consequence for how this plan is structured: there is no `schema.ts`
and no `APP_TENANT_TABLES` entry, and Phase 1 below is **contracts**, not schema. The
`.ai/rules/modules.md` "Adding a Tenant-Scoped Resource" steps still apply in spirit
(contracts → routes → e2e) but step 1 (table) and step 2 (RLS registration) are
genuinely not needed — flagging explicitly so this isn't mistaken for a skipped step.

Because every underlying table (`ChronoSales`, `ChronoSaleItems`, `ChronoSalePayments`,
`ChronoWalletTransactions`, `ChronoShifts`) is already RLS-forced and already reached
exclusively via `withTenant`, tenant isolation for this module is inherited for free —
the only way to break it here is to write a query that reaches one of those tables
**without** going through `withTenant`, which this plan explicitly forbids in every
route below.

### Pattern to copy (worked examples: `shift`, `pos`, `wallet`)

- `apps/chrono-api/src/modules/shift/routes.ts` — the pagination-meta helper
  (`buildPaginationMeta`), the `withTenant` read shape, and the `listShiftsQuerySchema`
  date/branch filter convention this plan's own query schemas mirror.
- `apps/chrono-api/src/modules/pos/schema.ts` — `ChronoSales.status` (`"completed" |
  "refunded"`), `ChronoSaleItems` (category comes from the snapshotted product, joined
  via `ChronoSaleItems.productId → ChronoProducts.category`), `ChronoSalePayments.method`
  (`"cash" | "card" | "wallet"`) — the exact columns every sales aggregation in this plan
  groups/sums over.
- `apps/chrono-api/src/modules/wallet/schema.ts` — `ChronoWalletTransactions.type`
  (`"credit" | "debit" | "adjustment"`) and `.amount` (signed decimal) — summed by type
  for the wallet-activity rollup.
- `packages/agora/src/ui` — `Sparkline` (compact single-series) and `TrendChart`
  (multi-series, capped at 5 series, semantic `--chart-1..5` tokens) — see
  `.ai/rules/component-first-ui.md`. Both are dependency-free inline SVG (no charting
  library in the repo); this plan uses them as-is, adds no new chart primitive. The
  `dataviz` skill governs any further chart-authoring decisions inside those components'
  own call sites (color, legend, empty-state rendering) — read it before building Phase
  4's chart usages, don't freehand a palette.
- `.ai/rules/business-app.md` — module folder convention:
  `apps/chrono-api/src/modules/report/` (singular domain noun) with `contracts.ts` +
  `routes.ts` only (no `schema.ts`).
- `.ai/rules/pagination.md` / `.ai/rules/data-listing.md` — the drill-down list views
  (Phase 2's `/reports/sales` line-level breakdown) are genuinely paginated
  (`listQuerySchema`); the KPI/trend routes are bounded aggregates and return a fixed
  small shape, not a paginated list — this plan does not force pagination onto an
  aggregate that doesn't need it.

### Contracts — `apps/chrono-api/src/modules/report/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

const MAX_RANGE_DAYS = 366;

export const dateRangeQuerySchema = z
  .object({
    branchId: z.string().min(1).optional(),
    from: z.string().date(), // "YYYY-MM-DD", inclusive, tenant-local calendar day
    to: z.string().date(), // inclusive
  })
  .refine((v) => new Date(v.to) >= new Date(v.from), {
    message: "to must not be before from",
    path: ["to"],
  })
  .refine(
    (v) =>
      (new Date(v.to).getTime() - new Date(v.from).getTime()) / 86_400_000 <=
      MAX_RANGE_DAYS,
    { message: `Range cannot exceed ${MAX_RANGE_DAYS} days.`, path: ["to"] },
  );

export const salesLineQuerySchema = dateRangeQuerySchema.and(
  listQuerySchema(["createdAt", "totalAmount"]),
);

export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;
```

Response shapes (not Zod-validated outbound per `.ai/rules/dto.md`'s "validate inbound,
shape outbound explicitly" convention, but documented here as the contract the typed
`/rpc` client shares with the web app):

- `SalesSummary`: `{ totalRevenue: string; saleCount: number; averageSaleValue: string;
  byCategory: { category: string; revenue: string; quantity: number }[]; byPaymentMethod:
  { method: string; amount: string }[]; dailySeries: { date: string; revenue: string }[]
  }`
- `ShiftSummary`: `{ shifts: { id: string; branchId: string; staffName: string; status:
  string; openingCashAmount: string; actualCashAmount: string | null;
  expectedCashAmount: string | null; differenceAmount: string | null; openedAt: string;
  closedAt: string | null }[] }` — a thin projection of `shift`'s own list route, filtered
  to the requested range, reused rather than re-queried where possible (see Routes).
- `WalletActivitySummary`: `{ totalCredited: string; totalDebited: string;
  netChange: string; transactionCount: number; dailySeries: { date: string; credited:
  string; debited: string }[] }`
- `DashboardOverview`: `{ today: { revenue: string; saleCount: number; openShiftCount:
  number }; trend: { date: string; revenue: string }[] }` — the single call the
  dashboard landing page makes; a compact merge of the above three, not a 4th
  independent query engine (see Routes: it re-uses the same aggregation SQL with a
  fixed 14-day range).

### Routes — `apps/chrono-api/src/modules/report/routes.ts`

All routes are `GET`, mounted under `/rpc/reports/*`, composed into `routes/rpc.ts`
exactly like every other module's `xRoutes()` factory.

```
GET /reports/overview
  — requirePermission(report: ["read"])
  — no query params; fixed "last 14 days, all branches the caller's tenant has"
  — returns DashboardOverview
  — withTenant: one query summing ChronoSales (status='completed') grouped by day,
    one query counting ChronoShifts where status='open'

GET /reports/sales-summary
  — zValidator("query", dateRangeQuerySchema)
  — requirePermission(report: ["read"])
  — branchId optional: when present, scopes to that branch (staff's normal case);
    when absent, aggregates every branch in the tenant — see Permission vocabulary,
    this is NOT gated as "all branches" server-side by itself, financial rollup gating
    lives on the /reports/financial-rollup route below instead, to keep this route's
    shape simple: an admin browsing without a branch filter is the tenant-wide view,
    a staff member without report:readFinancial gets it 403'd at the route level
    below if they omit branchId — see next bullet
  — if branchId is omitted AND caller lacks report:readFinancial → 403 (staff must pick
    a branch; only report:readFinancial can see the unscoped tenant-wide rollup)
  — withTenant: joins ChronoSales + ChronoSaleItems + ChronoProducts (category) +
    ChronoSalePayments (method), status='completed' only, createdAt within [from, to]

GET /reports/shift-summary
  — zValidator("query", dateRangeQuerySchema)
  — requirePermission(report: ["read"])
  — same branchId-omitted-requires-readFinancial rule as sales-summary
  — withTenant: reads ChronoShifts (+ join base.user for staffName, mirroring shift's
    own list route exactly) filtered by openedAt within [from, to]

GET /reports/wallet-activity
  — zValidator("query", dateRangeQuerySchema.omit({ branchId: true }))
  — requirePermission(report: ["readFinancial"])  — always admin+, no staff path;
    wallet is not branch-scoped (ChronoWallets has no branchId) so there is no
    "my branch's wallet activity" view to fall back to for staff — this route is
    simply the financial-rollup tier outright
  — withTenant: sums ChronoWalletTransactions by type, grouped by day, within range
```

**No `/reports/financial-rollup` as a separate route** — the "tenant-wide, all
branches" view is just `sales-summary`/`shift-summary` called with no `branchId`, gated
inline as described above, rather than a fourth duplicate-shaped route. This keeps one
query shape per report instead of a staff and an admin variant of each.

Every route follows the identical structure: validate query → `requirePermission` →
resolve `branchId` (if present) inside `withTenant` to confirm it belongs to the tenant
(404 if not, before running any aggregate) → run the aggregate query → shape the
response. No route ever writes.

### Permission vocabulary — per-app extension seam

Adds to `apps/chrono-api/src/auth/permissions.ts`'s `CHRONO_PERMISSION_STATEMENTS` (via
`registerAppPermissions()`, **never** `packages/agora/src/auth/permissions.ts` directly
— see `.ai/rules/business-app.md`, "Permissions: the per-app extension seam"):

```ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  report: ["read", "readFinancial"],
} satisfies Record<string, string[]>;

export const CHRONO_STAFF_GRANTS = {
  ...
  report: ["read"],
};

export const CHRONO_ADMIN_GRANTS = {
  ...
  report: ["read", "readFinancial"],
};
```

- `staff` — `report:read` only: overview, and per-branch sales/shift summaries (must
  supply `branchId`).
- `admin`/`owner` — both actions: everything staff sees, plus the unscoped tenant-wide
  rollup and the wallet-activity report.
- Deny-by-default is inherited automatically from `requirePermission`'s existing
  behavior (`.ai/rules/rbac.md`) — an unrecognized/customer-pool role gets 403 on every
  route in this module, same as everywhere else.

### Web UI — `apps/chrono-web/src/app/dashboard/reports/`

- `page.tsx` — client component. Landing view calls `GET /reports/overview` on mount:
  a KPI tile row (today's revenue, today's sale count, open shift count) each optionally
  paired with a `Sparkline` fed by `trend`, plus a `TrendChart` of the 14-day revenue
  series. A branch `Select` (same inline-picker precedent as `shifts`' own UI — no shared
  "current branch" context switcher exists yet) and a date-range control (reuse the
  `DateTimeInput` primitive added to `agora/ui` by the `reservations` plan, or a simpler
  date-only variant if that primitive is datetime-specific — check
  `packages/agora/src/ui` before adding a new one) drive `sales-summary`/`shift-summary`.
- `reports/sales/page.tsx` — the per-category/per-payment-method breakdown as two small
  `Card`s with simple tables (not a full `DataTable` — these are ≤10-row aggregate
  breakdowns, not paginated lists, so `useClientListPage` doesn't apply either; a plain
  table primitive suffices, per `.ai/rules/data-listing.md`'s carve-out for genuinely
  low-cardinality data — though here it's an aggregate result, not a list of rows, so
  neither the client nor server list machinery is the right fit; state this explicitly
  in the phase's code comment).
- `reports/wallet/page.tsx` — admin+-only page (the nav entry is hidden via `<Can>`/
  `can()` from `agora/ui` per `.ai/rules/rbac.md`'s "frontend checks are visibility
  only" — the route itself still enforces `report:readFinancial` server-side).
- Nav entry under Dashboard → Reports, visible to all tenant roles (staff sees the
  overview + their branch's summaries; the wallet/financial-rollup views self-hide via
  `<Can>` for non-admins).

### CRUD & Feedback Contract

This module has no entity of its own — no Create/Update/Delete surface. The only "CRUD"
row is **Read**, and it is the entire module:

| Action | Route | Permission | Notes |
|---|---|---|---|
| Read (dashboard) | `GET /rpc/reports/overview` | `report:read` | fixed 14-day window, no filters |
| Read (sales) | `GET /rpc/reports/sales-summary` | `report:read` (branch-scoped) / `report:readFinancial` (unscoped) | 404 on cross-tenant `branchId` |
| Read (shifts) | `GET /rpc/reports/shift-summary` | `report:read` (branch-scoped) / `report:readFinancial` (unscoped) | reuses `shift`'s own row shape |
| Read (wallet) | `GET /rpc/reports/wallet-activity` | `report:readFinancial` | admin+ only, no staff variant |

Feedback: no toasts on success (a report loading is not a mutation); a failed fetch
shows the existing `DataTableEmptyState`/error-state pattern or an inline `Card` error
message — no destructive-action confirmation dialogs anywhere in this module (nothing is
destructive). No audit linkage (read-only, per Pass 1).

---

## Phase 1 — Contracts

**Files to Update**
- `apps/chrono-api/src/modules/report/contracts.ts` (new)

**Step-by-Step Tasks**
1. Create the module folder `apps/chrono-api/src/modules/report/`.
2. Write `dateRangeQuerySchema`, `salesLineQuerySchema`, and the `DateRangeQuery` type
   exactly as specified above (cross-field `to >= from`, max-366-day cap).
3. Export the response-shape TS types documented above (`SalesSummary`, `ShiftSummary`,
   `WalletActivitySummary`, `DashboardOverview`) as plain `type`/`interface` declarations
   (not Zod — these are outbound shapes, not validated input, per `.ai/rules/dto.md`).

**Acceptance Criteria**
- `pnpm --filter @agora/chrono-api typecheck` passes with the new file compiling
  standalone (no route wiring yet).
- `dateRangeQuerySchema` rejects `to < from` and a range over 366 days; accepts a valid
  same-day range (`from === to`).

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`

**Out-of-Scope**
- Any route wiring, permission registration, or UI — later phases.

**Execution Start Point**
- New file, no existing code to read first beyond this plan's Contracts section.

---

## Phase 2 — Permission Registration

**Files to Update**
- `apps/chrono-api/src/auth/permissions.ts`

**Step-by-Step Tasks**
1. Add `report: ["read", "readFinancial"]` to `CHRONO_PERMISSION_STATEMENTS`.
2. Add `report: ["read"]` to `CHRONO_STAFF_GRANTS`.
3. Add `report: ["read", "readFinancial"]` to `CHRONO_ADMIN_GRANTS`.
4. Do **not** touch `packages/agora/src/auth/permissions.ts` — this resource is
   Chrono-specific and goes through the existing `registerAppPermissions()` seam only.

**Acceptance Criteria**
- `pnpm --filter @agora/chrono-api typecheck` passes.
- `apps/chrono-api/src/e2e/permissions.test.ts` (extend it) asserts: `hasPermission("staff",
  { report: ["read"] })` is `true`; `hasPermission("staff", { report: ["readFinancial"] })`
  is `false`; `hasPermission("admin"|"owner", { report: ["readFinancial"] })` is `true`;
  an unrecognized role gets `false` on both (deny-by-default).

**Verification Commands**
- `pnpm --filter @agora/chrono-api test:permissions` (or the equivalent script if
  named differently — check `apps/chrono-api/package.json` scripts first)

**Out-of-Scope**
- Route wiring (Phase 3).

**Execution Start Point**
- Read `apps/chrono-api/src/auth/permissions.ts` in full before editing — the exact
  three-object shape (`CHRONO_PERMISSION_STATEMENTS`/`CHRONO_STAFF_GRANTS`/
  `CHRONO_ADMIN_GRANTS`) must stay internally consistent (every action in the
  statements object must appear in at least one grant object).

---

## Phase 3 — Routes

**Files to Update**
- `apps/chrono-api/src/modules/report/routes.ts` (new)
- `apps/chrono-api/src/routes/rpc.ts` (mount `reportRoutes()`)
- `apps/chrono-api/src/e2e/permissions.test.ts` (extend, if the gate isn't already
  proven by Phase 2's unit assertions — add an actual route-level 403 test)

**Step-by-Step Tasks**
1. Implement `reportRoutes()` exactly per the four routes specified in Pass 2 — each:
   validates query, calls `requirePermission` from `apps/chrono-api/src/auth/
   require-permission.ts` (never `agora/auth` directly, per the extension-seam rule),
   resolves and 404s an unknown `branchId` inside `withTenant` before aggregating, runs
   the aggregate query, returns the shaped response.
2. For `sales-summary`/`shift-summary`, implement the "no branchId → require
   `report:readFinancial`" inline check as a `hasPermission` call (not `requirePermission`,
   since the base action `report:read` already passed) before proceeding to the
   unscoped query path.
3. Compose `reportRoutes()` into `apps/chrono-api/src/routes/rpc.ts` alongside the
   existing module routers (`shiftRoutes()`, `reservationRoutes()`, etc.) — this is the
   only file that changes to wire a new module in, per `.ai/rules/business-app.md`'s
   folder-structure table.
4. Write a deterministic aggregation test (not a concurrency test — there's no race
   condition in a read-only module) seeding a few `ChronoSales`/`ChronoWalletTransaction`/
   `ChronoShift` rows directly via the test DB and asserting the aggregate math (sums,
   grouping, date-range filtering) is correct, including the zero-rows/empty-tenant case
   (Pass 1's "empty-state" failure case).

**Acceptance Criteria**
- All four routes return correct, tenant-scoped aggregates against seeded data.
- A cross-tenant `branchId` returns 404, not an empty/zeroed report.
- Staff omitting `branchId` on `sales-summary`/`shift-summary` gets 403; supplying one
  they own gets 200.
- `wallet-activity` 403s for staff unconditionally.
- Empty tenant (no sales/shifts/wallet rows) returns zeroed aggregates, not a 500 or a
  `null`-shaped crash.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:e2e` (or module-local test runner per
  `apps/chrono-api/src/e2e/run.ts`'s existing convention)
- `pnpm --filter @agora/chrono-api rls:proof` — no schema changed, but re-run as a sanity check
  per `.ai/rules/testing.md`'s "any change that touches withTenant" guidance, since this
  phase adds several new `withTenant` call sites.

**Out-of-Scope**
- Web UI (Phase 4).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/shift/routes.ts` in full (already read during
  planning) — copy its `buildPaginationMeta`-adjacent structure and `withTenant` shape
  verbatim for the aggregation queries' scaffolding, even though these routes don't
  paginate.

---

## Phase 4 — Web UI

**Files to Update**
- `apps/chrono-web/src/app/dashboard/reports/page.tsx` (new)
- `apps/chrono-web/src/app/dashboard/reports/sales/page.tsx` (new)
- `apps/chrono-web/src/app/dashboard/reports/wallet/page.tsx` (new)
- `apps/chrono-web/src/components/dashboard/report/` (new, if any report-specific
  composed components are needed beyond direct `agora/ui` primitive usage)
- Dashboard nav config (wherever `shifts`/`branches` nav entries are registered)

**Step-by-Step Tasks**
1. Load the `dataviz` skill before writing any chart usage in this phase (per its own
   trigger condition — this phase creates `Sparkline`/`TrendChart` usages).
2. Build the overview page: KPI tiles + `TrendChart`, branch picker, date-range control,
   calling the typed `api.rpc.reports.overview.$get()` / `.["sales-summary"].$get({
   query })` client methods.
3. Build the sales breakdown and wallet-activity sub-pages per the Web UI section above.
4. Add the nav entry; gate the wallet-activity link's visibility with `<Can>` on
   `report:readFinancial` (visibility only — the route enforces the real gate).
5. Every raw-HTML-chrome scan required by `.ai/rules/ai-agent.md` — no new `div`/`main`/
   etc. wrappers; compose from `agora/ui` `Card`/`Button`/`Select` primitives only.

**Acceptance Criteria**
- Staff sees the overview + branch-scoped sales/shift summaries; the wallet-activity nav
  link is hidden for staff and 403s if navigated to directly.
- Admin sees everything, including the unscoped (no-branch) rollup and wallet activity.
- Empty-tenant / zero-data states render a clear empty state, not a blank/broken chart.
- No raw HTML chrome introduced (component-first-ui.md compliance).

**Verification Commands**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual check: `pnpm dev`, visit `{tenant}.localtest.me:3000/dashboard/reports` as both
  a staff and an admin session.

**Out-of-Scope**
- E2e spec (Phase 5).

**Execution Start Point**
- Read `apps/chrono-web/src/app/dashboard/shifts/page.tsx` (or the nearest existing
  dashboard list page) for the `useListQuery()`/typed-client/`agora/ui` composition
  pattern before writing new pages — this phase does not invent new page-shell
  conventions.

---

## Phase 5 — E2E Spec

**Files to Update**
- `apps/chrono-web/e2e/tests/reports/dashboard-overview.spec.ts` (new)
- `apps/chrono-web/e2e/tests/reports/role-gate.spec.ts` (new)
- `apps/chrono-web/e2e/tests/reports/tenant-isolation.spec.ts` (new)

**Step-by-Step Tasks**
1. Happy path: seed a branch, a couple of `pos` sales (via the API directly, since `pos`
   UI may not exist yet — check `pos`'s own implementation status before writing this),
   a shift, and assert the overview page renders the correct revenue tile.
2. Role gate: assert a `staff` session can view the branch-scoped sales summary but gets
   blocked (UI hides the link; a direct API call 403s) from `wallet-activity` and the
   unscoped rollup; an `admin` session can see both.
3. Tenant isolation: seed data in tenant A and tenant B, assert tenant B's dashboard
   never shows tenant A's revenue/shift numbers, and a direct cross-tenant `branchId`
   query param returns 404.

**Acceptance Criteria**
- All three specs pass headed against `pnpm dev` per `.ai/rules/rbac.md`'s "Testing"
  section (manual Playwright run, no `webServer` in config, real Postgres, not PGlite).

**Verification Commands**
- `pnpm dev` (separately, kept running)
- `pnpm --filter @agora/chrono-web test:e2e -- reports` (or the repo's actual Playwright
  invocation — check `apps/chrono-web/package.json`)

**Out-of-Scope**
- Nothing further — this is the module's last phase.

**Execution Start Point**
- Read an existing e2e spec under `apps/chrono-web/e2e/tests/` (e.g. `reservations` or
  `shifts` if one exists) for the faker-based test-data convention
  (`.ai/rules/e2e-testing.md`) before writing these three specs.

---

## Out of Scope (this plan)

- CSV/PDF export or scheduled email delivery of any report — no such surface requested;
  a legitimate follow-up, not silently built.
- Any new table, ledger, or materialized/rollup cache — every query in this plan runs
  live against existing tables; if aggregate query performance becomes a real problem at
  scale, a follow-up plan introduces a rollup table then, not preemptively here.
- `/rpc-admin` platform-wide cross-tenant analytics — unrelated surface
  (`.ai/rules/rbac.md`'s `usage`/`billing` resources already cover platform-level
  metering; this module is entirely tenant-scoped).
- Populating `ChronoShifts.expectedCashAmount`/`differenceAmount` — that computation is
  the `reconciliation` module's job (see its own plan), not this one's. This plan only
  **reads** those columns wherever they're already populated.
- Any write/mutation route — this module is 100% `GET`.
- Realtime/live-updating dashboards — plain load/refresh only, per the handover's
  `chrono-realtime-updates` deferral.
