# Chrono — `shifts` module

**Depends on:** `branches` only (schema references `chronoBranch`). Same tier as
`stations` — both wait on `branches`, neither depends on the other. No other Wave-1
module currently depends on `shifts`.

## What this is

A shift is a **cash-drawer/till session** worked by a staff member at a branch — open
it with a starting cash float, work it, close it by counting the actual cash on hand.
It is not an employee-scheduling/roster feature ("who's scheduled to work Tuesday
9–5") — oikos has no such thing under the name "shift"; that concept doesn't exist
anywhere in the source. **"Staff" here is agora's foundation `member`** (Better Auth
org membership: owner/admin/staff roles) — completely separate from `tenantMember`
(the venue's paying customers, planned in the `members` module). A shift's "who worked
it" reference is a Better Auth `user` id, never a `tenantMember` id.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff / Admin / Owner** — all three tenant roles may open and close a shift. This
  is a floor-level work action (like clocking in), not a configuration action, so it
  is deliberately **not** admin+-gated the way `branch` CRUD is — oikos gates both
  `open` and `close` at `requireRole(['OWNER', 'STAFF'])`, i.e. every tenant role.
- **Platform admin (`/rpc-admin`)** — not built in this pass. Out of scope.

**Workflow:** A staff member arriving at a branch opens **Dashboard → Shifts**, clicks
**Open Shift**, picks the branch (no shared "current branch" context switcher exists
yet — see Pass 2), enters their starting cash float, optional notes, and submits. The
new shift appears with status `open`. At the end of their shift they find their own
open row and click **Close Shift**, enter the actual cash counted plus optional notes,
and submit — the row flips to `closed` with `actualCashAmount` recorded. Any
authenticated tenant member can see the full shift log (accountability/audit trail),
not just their own rows — oikos's list route is role-ungated (`requireAuth,
requireBranch`, no `requireRole`).

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Opening a second shift in the **same branch** while one is already open for that
  staff member → 409 (`You already have an open shift in this branch.`) — ported
  verbatim from oikos's `openShift` check, plus a DB-level partial unique index as a
  race-condition backstop (see Schema).
- Closing an already-closed shift, or a shift id that doesn't exist for the caller's
  tenant → 404.
- A `branchId` on open that doesn't belong to the caller's tenant → 404 (`Branch not
  found`), checked explicitly before insert — never a raw FK-violation 500, and never
  a cross-tenant existence leak.
- Invalid amount format (non-numeric, more than 2 decimal places) → 400 (Zod).
- Wrong tenant/host → `tenantMiddleware()` never resolves `c.var.tenant`.
- **Tenant-isolation leak scenario**: tenant A opens a shift at their branch; tenant
  B's shift list must never show it, and tenant B closing tenant A's shift id must
  get 404 (never 403 — no existence leak).
- Stale screen: two staff closing the same shift concurrently — last write wins,
  same as `branch` (no optimistic lock in this pass).

**Audit / notifications:** every open/close writes a `recordStaffAudit` entry
(`shift.opened` / `shift.closed`), matching `branch`/`project`. No webhook event in
this pass — same call as the `branches` plan (`shift.opened`/`shift.closed` isn't in
`WEBHOOK_EVENTS`; adding one is a trivial, un-required follow-up).

---

## Pass 2 — Technical Planning

### What exists today in oikos (source of truth for "what exists")

- `apps/chrono-api/src/database/schema/shifts.ts` (oikos) — `Shift` table (`Shifts`,
  uuid PK): `tenantId`, `branchId` FK, `cashierUserId` FK → `User` (`onDelete:
  'restrict'` — a shift's history must survive even if a user account is later
  deleted), `status` (`ShiftStatusEnum`: `OPEN`/`CLOSED`, Postgres enum), `openedAt`
  (default now), `closedAt` (nullable), `openingCashAmount`/`closingCashAmount`/
  `expectedCashAmount`/`actualCashAmount`/`differenceAmount` (all `numeric(12,2)`,
  nullable except `openingCashAmount`), `metadataJson` (jsonb, holds `notes`).
  **Note**: `closingCashAmount` is defined but never written anywhere in
  `service.ts` — the close path only ever sets `actualCashAmount`. Dead column; not
  carried into agora.
- `apps/chrono-api/src/modules/shifts/dto.ts` (oikos) — `openShiftSchema`
  (`openingCashAmount` as a `\d+(\.\d{1,2})?` string, optional `metadata`),
  `closeShiftSchema` (`actualCashAmount` same format, optional `metadata`).
- `apps/chrono-api/src/modules/shifts/routes.ts` (oikos) — `GET /` (list, role-
  ungated, `requireAuth + requireBranch`, tenant+optional-branch filtered, paginated
  via `limit`/`offset`), `GET /current` (the caller's own open shift in the resolved
  branch), `POST /open` (`requireRole(['OWNER','STAFF'])`), `POST /:id/close` (same
  role gate).
- `apps/chrono-api/src/modules/shifts/service.ts` (oikos) — business logic:
  - `openShift`: refuses a second open shift for the same `(branchId,
    cashierUserId)` (app-level query, not a DB constraint) → throws (routed to 400).
  - `closeShift`: looks up by `(id, tenantId, branchId)` **only** — does **not**
    check that the closer is the same user who opened it. Throws if not found or
    already closed. Computes `expectedCashAmount = openingCash +
    reconciliationService.calculateExpectedCash({ shiftId })` (sums the `CASH`
    portion of `Payment` rows tagged with this shift's id), then
    `differenceAmount = actualCash - expectedCash`.
  - `getCurrentShift`: most recent `OPEN` shift for `(branchId, cashierUserId)`.
  - `requireOpenShiftForCash`: used by the (unbuilt) POS/payments path to refuse a
    cash sale with no open shift to attribute it to.
- `apps/chrono-api/src/modules/reconciliation/service.ts` (oikos) —
  `calculateExpectedCash({ shiftId })` sums `Payment` rows where
  `Payment.shiftId = shiftId` and `status = 'PAID'`, extracting the cash portion
  (handles split-tender sales via `metadataJson.payments`). **This entire code path
  depends on `Payment.shiftId` and the `Payment` table, neither of which exist in
  agora yet** — `pos`/`payments`/`reconciliation` are explicitly deferred, later-wave
  modules per `.ai/handover/chrono-migration.md`. See Open Question 2.
- `apps/chrono-web/src/app/tenant/admin/(authenticated)/[branchCode]/shifts/` (oikos)
  — `page.tsx` (server component, paginated list + current-shift fetch),
  `shifts-client.tsx` (Open/Close dialogs, `DataTable`, `StatusBadge`), `actions.ts`
  (server actions). Notably: the **Close** button only ever renders on the row where
  `status === "open" && id === currentShift?.id` (`isMyOpenShift`) — even though the
  API itself would let any `OWNER`/`STAFF` close any open shift, the UI only ever
  surfaces closing *your own*. A `"Report"` button appears on closed rows but links
  nowhere real in the traced code (the `reports` module is deferred).
- `apps/chrono-web/src/lib/tenant-ops.ts` (oikos) — REST client; `Shift`/
  `CurrentShift` wire types map `status` to lowercase `"open"`/`"closed"` client-side
  and derive a display `staffName` the raw `GET /` select doesn't actually join in
  the traced server code — a pre-existing gap, not carried into this plan (agora's
  route joins `user` explicitly, see Routes below).

### Branch-scoping (`UserBranchAccess`) — not applicable to shifts either

Per the `branches` plan's Open Question 3, oikos's `UserBranchAccess` table (staff→
branch visibility) has **zero CRUD surface anywhere in oikos** and was deliberately
**not** ported. Shifts route through the same general `requireBranch`/branch-context
middleware oikos uses everywhere, which is where that access-scoping would apply if
it existed — but since agora doesn't build that table, **shift open/close in this
pass is unrestricted by branch**: any staff member holding `shift:open`/`shift:close`
may open or close a shift at any branch the tenant operates. Consistent with the
`branches` plan's own resolution; not re-litigated here.

### Pattern to copy in agora

- `apps/chrono-api/src/modules/branch/schema.ts` + `.../branch/contracts.ts` +
  `.../branch/routes.ts` (already landed for `branches`, Phase 1 in progress) — the
  exact module shape to mirror: `pgTable` + `APP_TENANT_TABLES` entry, Zod contracts
  local to the module, a Hono factory composed into `apps/chrono-api/src/routes/
  rpc.ts` via `.route("/shifts", shiftRoutes())`.
- `apps/chrono-api/src/routes/rpc.ts`'s `/members` GET — the join-with-`user`
  pattern this module needs (`staffName`/`staffEmail` come from `base.user`, joined
  inside the same query).
- `.ai/rules/business-app.md` — module folder `apps/chrono-api/src/modules/shift/`
  (kebab-case singular noun, matching `branch`), contracts stay local.

### Schema — `ChronoShifts`

New file `apps/chrono-api/src/modules/shift/schema.ts`:

```ts
import { pgTable, text, timestamp, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";

export const chronoShift = pgTable(
  "ChronoShifts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // The Better Auth foundation user who worked this shift — NEVER a
    // tenantMember id. `onDelete: "restrict"` (not "cascade"/"set null"): a
    // shift's cash-accountability history must not silently disappear or
    // orphan if a staff account is later deleted.
    staffUserId: text("staffUserId")
      .notNull()
      .references(() => base.user.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("open"), // "open" | "closed"
    openingCashAmount: numeric("openingCashAmount", { precision: 12, scale: 2 }).notNull(),
    openedAt: timestamp("openedAt").notNull().defaultNow(),
    closedAt: timestamp("closedAt"),
    actualCashAmount: numeric("actualCashAmount", { precision: 12, scale: 2 }),
    // Populated by a future pos/reconciliation module once Payment rows exist
    // to sum — always null in this pass. See Open Question 2.
    expectedCashAmount: numeric("expectedCashAmount", { precision: 12, scale: 2 }),
    differenceAmount: numeric("differenceAmount", { precision: 12, scale: 2 }),
    openNotes: text("openNotes"),
    closeNotes: text("closeNotes"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_shift_tenant_idx").on(t.tenantId),
    index("chrono_shift_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_shift_staff_idx").on(t.staffUserId),
    index("chrono_shift_status_idx").on(t.status),
    // DB-level backstop for the "already have an open shift in this branch"
    // rule — the app-level check in the open route is the primary guard;
    // this partial unique index closes the race window between two rapid
    // double-submits (a correctness guarantee the oikos app-only check
    // didn't have), mirroring branch's own "composite unique index, not
    // just an RLS/app-level guarantee" reasoning.
    uniqueIndex("chrono_shift_one_open_per_staff_idx")
      .on(t.tenantId, t.branchId, t.staffUserId)
      .where(sql`"status" = 'open'`),
  ],
);

export type NewChronoShift = typeof chronoShift.$inferInsert;
export type ChronoShiftRow = typeof chronoShift.$inferSelect;
```

Deliberate differences from the oikos `Shift` table:

- `text`/`createId()` id, not `uuid`/`defaultRandom()` (foundation convention).
- `status` is free-text (`"open"`/`"closed"`) enforced at the Zod layer, not a
  Postgres enum — same reasoning as `branch.status` (`database.md`'s dominant
  convention over `pgEnum`, sidesteps non-idempotent `CREATE TYPE`).
- `closingCashAmount` dropped — dead column in oikos (never written).
- `metadataJson` (a single jsonb blob holding `{ notes }`) is split into two
  explicit `openNotes`/`closeNotes` text columns instead of one jsonb key. This
  isn't just the `branches` plan's "promote real fields out of a jsonb blob"
  pattern — oikos's `close` path does `{ ...existing.metadataJson, ...data.metadata
  }`, and both open and close notes are stored under the **same** `notes` key, so
  closing a shift silently overwrites its own opening notes. Two explicit columns
  fix that bug rather than port it.
- **Partial unique index** (`chrono_shift_one_open_per_staff_idx`) — new; oikos only
  ever enforced "one open shift per staff per branch" in application code. A DB
  constraint is strictly better and free to add now.
- No `UserBranchAccess`-equivalent scoping — see "Branch-scoping" above.

### `APP_TENANT_TABLES`

Add `"ChronoShifts"` to the array in `apps/chrono-api/src/db/schema.ts`, and
re-export `chronoShift` from the module into that file (same composition point as
`chronoBranch`).

### Contracts — `apps/chrono-api/src/modules/shift/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const shiftStatusSchema = z.enum(["open", "closed"]);

// Decimal-string money, matching oikos's own wire format (precision-safe,
// database.md: numeric/decimal, never floating point).
const moneyStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Invalid amount format");

export const openShiftSchema = z.object({
  branchId: z.string().min(1),
  openingCashAmount: moneyStringSchema,
  notes: z.string().max(1000).optional(),
});

export const closeShiftSchema = z.object({
  actualCashAmount: moneyStringSchema,
  notes: z.string().max(1000).optional(),
});

export const listShiftsQuerySchema = listQuerySchema(["openedAt", "closedAt"]).extend({
  branchId: z.string().optional(),
  status: shiftStatusSchema.optional(),
});

export type OpenShiftInput = z.infer<typeof openShiftSchema>;
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;
```

### Routes — `apps/chrono-api/src/modules/shift/routes.ts`

A Hono factory `shiftRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/shifts", shiftRoutes())`:

- `GET /` — **ungated** (any tenant member — matches oikos's role-ungated list;
  full accountability log, not "my shifts only"). `zValidator("query",
  listShiftsQuerySchema)`; optional `branchId`/`status` filters; `withTenant`,
  joined with `base.user` for `staffName`/`staffEmail` (mirrors the `/members`
  join pattern in `rpc.ts`); returns `{ items, meta }` (`buildPaginationMeta`).
- `GET /current` — **ungated, self-scoped** (no separate permission — the caller can
  only ever see their own current shift, same shape as `/notification-feed`).
  Requires a `branchId` query param (400 if missing — agora has no shared
  "current branch" context to infer it from; see Web UI). Returns the caller's most
  recent `open` shift in that branch, or `null`.
- `POST /open` — `requirePermission(c.var.tenant.permissions, { shift: ["open"] })`.
  Validates `openShiftSchema`. Inside `withTenant`: look up `branchId` scoped to the
  caller's tenant first (404 `Branch not found` if it doesn't resolve — never a raw
  FK 500, never a cross-tenant existence leak); check for an existing `open` shift
  for `(tenantId, branchId, staffUserId = c.var.tenant.userId)` → 409 if found (the
  partial unique index is the race-condition backstop, not the primary path); insert
  with `staffUserId` **always** `c.var.tenant.userId` — never client-supplied (no
  "open a shift on behalf of someone else" in this pass). `recordStaffAudit({
  action: "shift.opened", ... })`.
- `POST /:id/close` — `requirePermission(c.var.tenant.permissions, { shift:
  ["close"] })`. Validates `closeShiftSchema`. **Open Question 1**: matches oikos's
  actual behavior — not restricted to the shift's own opener, any actor holding
  `shift:close` (i.e. any tenant role) may close any open shift in the tenant
  (useful for shift handover: an incoming cashier closes the outgoing one's till).
  404 if the shift doesn't belong to the caller's tenant; 409 if already `closed`.
  Sets `status: "closed"`, `closedAt`, `actualCashAmount`, `closeNotes`.
  `expectedCashAmount`/`differenceAmount` are **not** computed in this pass (see
  Open Question 2) — left `null`. `recordStaffAudit({ action: "shift.closed",
  ... })`.

No `DELETE /shifts/:id` — shifts are an audit trail; nothing in oikos deletes one.

### Permission vocabulary

Adds to `packages/agora/src/auth/permissions.ts` (same precedent as `branch`):

```ts
export const PERMISSION_STATEMENTS = {
  ...
  shift: ["open", "close"],
} as const;
```

- `staffRole` — **gets both** `shift: ["open", "close"]` (unlike `branch`, this is a
  floor-level work action every tenant role performs, matching oikos's
  `requireRole(['OWNER', 'STAFF'])` on both routes).
- `adminRole` — **gets both** `shift: ["open", "close"]` (admins can do everything
  staff can here, same as `project`/`file`).
- `ownerRole` — inherits automatically.

Since every system role holds this permission, the meaningful "gate" to test in
`permissions.test.ts` is **deny-by-default**, not a staff-vs-admin split: assert
`hasPermission("staff"|"admin"|"owner", { shift: ["open"] })` are all `true`, and
`hasPermission("member", { shift: ["open"] })` (an unrecognized/customer-pool role
value) is `false` — see Phase 3.

**Open Question 1** (flagged above, repeated here for visibility): close is
permission-gated, not ownership-gated. If the developer wants "only the shift's own
opener (or admin+) may close it" instead, that's a one-line addition to the `WHERE`
clause (`and(eq(chronoShift.id, id), or(eq(chronoShift.staffUserId, userId),
inArray(role, ["admin","owner"])))`) — flagging so it's a deliberate choice.

**Open Question 2**: `expectedCashAmount`/`differenceAmount` stay in the schema
(nullable) but are **never computed** in this pass, because the computation depends
on `Payment.shiftId` and the `Payment` table, both owned by the deferred
`pos`/`payments`/`reconciliation` modules (not in Wave 1 per
`.ai/handover/chrono-migration.md`). The UI shows "—" for both, same as oikos
already does for a shift with `expectedCashAmount === null`. When a future
`pos`/`reconciliation` module lands, it adds `Payment.shiftId` (FK → `ChronoShifts`)
in its **own** migration and a service function that back-fills these two columns at
close time — no `ChronoShifts` migration needed then, since the columns already
exist. Flagging in case the developer would rather **not** carry these two columns
until that module exists (matching the `branches` plan's stricter "don't build ahead
of a real requirement" stance on `UserBranchAccess`) — the one-line alternative is to
drop both columns now and add them via a new migration when `pos`/`reconciliation`
actually lands.

### Web UI — `apps/chrono-web/src/app/dashboard/shifts/`

- `page.tsx` — client component (mirrors `apps/chrono-web/src/app/dashboard/
  branches/page.tsx`/`projects/page.tsx`): `useListQuery()` for URL-driven
  page/pageSize/q/sort/order/view, `api.rpc.shifts.$get({ query: {...} })`,
  `DataTable`/`DataTableGrid` + `DataTableToolbar` + `DataTablePagination` from
  `agora/ui`. Columns: status badge, staff name, branch, opened/closed times,
  opening cash, actual cash, expected/variance (always "—" this pass, see Open
  Question 2).
- **Open Shift** dialog: a branch `Select` (populated from `api.rpc.branches.$get`
  — there is no shared "current branch" context switcher yet, same deferral as the
  `branches` plan's own Out of Scope; this module adds its own inline picker rather
  than inventing a shared one), opening-cash `Input`, notes `Input`. All via
  `agora/ui` primitives only (`.ai/rules/component-first-ui.md`).
- **Close Shift** action: the Close button renders **only** on the row that is both
  `status === "open"` and `staffUserId === (the caller's own userId, from
  /rpc/me)`— mirroring oikos's `isMyOpenShift` UI check exactly, even though the API
  itself (Open Question 1) would allow closing any open shift. Frontend role checks
  are visibility only (`.ai/rules/rbac.md`); this is a UX choice matching the source
  app's own UI, not a new security boundary.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Shifts` entry to
  `BASE_NAV` (a `Clock`-style `lucide-react` icon) and `"/dashboard/shifts":
  "Shifts"` to `TITLES`, mirroring the `Projects`/`Branches` entries.
- No module-registry feature-flag gate — shifts are core Chrono ops, not optional
  (same reasoning as `branches`). Confirm with the developer if a kill-switch is
  wanted anyway.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List | `GET /rpc/shifts` | none (any tenant member) | paginated, filterable by `branchId`/`status`, joined with staff name |
| Current | `GET /rpc/shifts/current?branchId=` | none (self-scoped) | caller's own open shift in that branch, or `null` |
| Open | `POST /rpc/shifts/open` | `shift:open` | 409 if the caller already has an open shift in that branch; 404 if `branchId` isn't the caller's tenant's |
| Close | `POST /rpc/shifts/:id/close` | `shift:close` | 404 cross-tenant/not-found; 409 if already closed; no expected/variance computed (Open Question 2) |
| Delete | — | — | **not built this pass** — shifts are an immutable audit trail once created |

Feedback: `toast.success`/`toast.error` at the point of the API call, matching
`Projects`/`Branches` (no separate `<FormError>`).

Audit linkage: `recordStaffAudit` on open/close, same as `branch`/`project`; no
confirmation dialog beyond the existing Open/Close dialogs themselves (not
destructive — closing is not reversible in this pass, matching oikos, but it's a
routine end-of-shift action, not a delete).

### Out of Scope (this plan)

- Employee scheduling/rostering ("who's scheduled to work when") — not a concept
  that exists in oikos under "shifts" or anywhere else traced; if the developer
  actually wants shift *scheduling*, that is a different, unbuilt feature.
- Automatic `expectedCashAmount`/`differenceAmount` computation from POS sales —
  depends on the deferred `pos`/`payments`/`reconciliation` modules (Open
  Question 2).
- `Payment.shiftId` — belongs to the future `pos`/`payments` module's own schema
  when it lands; not added here.
- `ChronoStaffBranchAccess` / per-branch staff scoping — consistent with the
  `branches` plan's Open Question 3 deferral; shift open/close is unrestricted by
  branch in this pass.
- A shared "current branch" context switcher (the `[branchCode]` URL segment /
  cookie oikos used) — same deferral as `branches`; this module's UI uses its own
  inline branch picker instead.
- The `/rpc-admin` platform-admin cross-tenant shift view.
- Editing or reopening a closed shift — no such route in oikos, none built here.
- A `shift.opened`/`shift.closed` webhook event — trivial follow-up, not required.
- Module-registry (`modules.shift`) feature-flag gating of the nav entry.
- `requireOpenShiftForCash` (oikos's POS-side guard requiring an open shift before
  a cash sale) — belongs to the future `pos` module, which will call into this
  module's `chronoShift` table/service, not the other way around.
- Any `stations`/`devices`/`members`/`wallet`/`sessions` code — separate, dependent
  plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/shift/schema.ts` (new) — `chronoShift` table (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export `chronoShift`, add
  `"ChronoShifts"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/shift/` and write `schema.ts` exactly as
   specified in Pass 2 (table name `"ChronoShifts"`, all five indexes including the
   partial unique index).
2. In `apps/chrono-api/src/db/schema.ts`, add `import { chronoShift } from
   "../modules/shift/schema";` + `export { chronoShift };` (matching the existing
   `chronoBranch` line) and append `"ChronoShifts"` to `APP_TENANT_TABLES`.
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_shifts` (never
   `db:push`). Review the generated SQL: expect `CREATE TABLE "ChronoShifts"`, its
   FKs to `Organizations`/`ChronoBranches`/`User`, four plain indexes, and one
   partial unique index with a `WHERE` clause — no destructive statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- `ChronoShifts` exists with `FORCE ROW LEVEL SECURITY` on.
- `"ChronoShifts"` is present in `APP_TENANT_TABLES`.
- Migration reviewed, no destructive/unexpected statements, partial unique index
  present.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/shift/schema.ts`.
(Depends on `apps/chrono-api/src/modules/branch/schema.ts` already existing — it
does, `branches` Phase 1 has landed locally per the handover doc.)

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/shift/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `shiftStatusSchema`, `openShiftSchema`, `closeShiftSchema`,
   `listShiftsQuerySchema` and their `z.infer` types exactly as specified in Pass 2.
2. No changes to `packages/agora/src/contracts` — module contracts stay local
   (`business-app.md`).

**Acceptance criteria**

- `OpenShiftInput`/`CloseShiftInput`/`ShiftStatus`/`ListShiftsQuery` types compile
  and are importable from `../modules/shift/contracts`.
- `listShiftsQuerySchema` accepts the base `listQuerySchema` fields plus optional
  `branchId`/`status`.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/shift/contracts.ts`.

---

## Phase 3 — Routes + permission gates

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `shift: ["open", "close"]` to
  `PERMISSION_STATEMENTS`, `staffRole`, and `adminRole` (see Pass 2).
- `apps/chrono-api/src/modules/shift/routes.ts` (new) — `shiftRoutes()` factory.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/shifts", shiftRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add a `shift` gate case (see
  below — deny-by-default, not a staff-vs-admin split).

**Step-by-step tasks**

1. Add `shift: ["open", "close"]` to `PERMISSION_STATEMENTS`, `staffRole`'s
   composed statement object, and `adminRole`'s (owner inherits automatically).
2. Write `apps/chrono-api/src/modules/shift/routes.ts`:
   - `GET /` — ungated, `listShiftsQuerySchema`, optional `branchId`/`status`
     filters, `withTenant` + join `base.user` for staff name/email, paginated.
   - `GET /current` — ungated, self-scoped by `c.var.tenant.userId`, requires a
     `branchId` query param (400 if missing), returns the caller's most recent
     `open` shift in that branch or `null`.
   - `POST /open` — `requirePermission(..., { shift: ["open"] })`, validate
     `branchId` resolves inside the caller's tenant (404 if not), check for an
     existing open shift for `(tenantId, branchId, staffUserId)` (409 if found),
     insert with `staffUserId = c.var.tenant.userId`, `recordStaffAudit`.
   - `POST /:id/close` — `requirePermission(..., { shift: ["close"] })`, 404 if the
     shift isn't in the caller's tenant, 409 if already `closed`, update
     `status`/`closedAt`/`actualCashAmount`/`closeNotes` (leave
     `expectedCashAmount`/`differenceAmount` `null`), `recordStaffAudit`.
   Follow the exact structure of the `branch`/`project` blocks (import style,
   `HttpError`, pagination meta shape via `buildPaginationMeta`).
3. Compose into `apps/chrono-api/src/routes/rpc.ts` via `.route("/shifts",
   shiftRoutes())`.
4. Add a `shift` case to `permissions.test.ts`: assert
   `hasPermission("staff", { shift: ["open"] }) === true`,
   `hasPermission("admin", { shift: ["open"] }) === true`,
   `hasPermission("owner", { shift: ["open"] }) === true`,
   `hasPermission("staff"|"admin"|"owner", { shift: ["close"] })` all `true`, and
   `hasPermission("member", { shift: ["open"] }) === false` (deny-by-default for an
   unrecognized/customer-pool role value — the real gate here, since every system
   role holds this permission).

**Acceptance criteria**

- `GET /rpc/shifts` returns `{ items, meta }` for any authenticated tenant member,
  filterable by `branchId`/`status`.
- `GET /rpc/shifts/current?branchId=X` returns the caller's own open shift in
  branch X, or `null`; 400 if `branchId` is omitted.
- `POST /rpc/shifts/open` as staff/admin/owner → 201; a second open in the same
  branch for the same caller → 409; a `branchId` from another tenant → 404.
- `POST /rpc/shifts/:id/close` on another tenant's shift id → 404; on an
  already-closed shift → 409; success sets `actualCashAmount` and leaves
  `expectedCashAmount`/`differenceAmount` `null`.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `shift`
  cases included.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out of scope:** UI, e2e browser spec (Phase 5).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (the
routes file imports `requirePermission` against the new resource, so the vocabulary
must exist before the route file typechecks).

---

## Phase 4 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/shifts/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed
  (none expected).

**Step-by-step tasks**

1. Build `page.tsx` mirroring `apps/chrono-web/src/app/dashboard/branches/
   page.tsx`: `useListQuery()`, `api.rpc.shifts.$get/$post` typed calls,
   `DataTable`/`DataTableGrid` + `DataTableToolbar` + `DataTablePagination`.
2. Add an **Open Shift** `Dialog`: branch `Select` (from `api.rpc.branches.$get`),
   opening-cash `Input`, notes `Input` — all `agora/ui` primitives only
   (`.ai/rules/component-first-ui.md`).
3. Add a **Close Shift** `Dialog`, triggered only from the row matching the
   caller's own open shift (fetch `/rpc/me` for the caller's `userId`, compare to
   `staffUserId`): actual-cash `Input`, notes `Input`.
4. Wire `toast.success`/`toast.error` on open/close, matching the `Projects`/
   `Branches` pages' inline-error convention.
5. Add `{ type: "item", name: "Shifts", href: "/shifts", icon: <a Clock-style
   lucide-react icon> }` to `BASE_NAV`, and `"/dashboard/shifts": "Shifts"` to
   `TITLES`, in `apps/chrono-web/src/app/dashboard/layout.tsx`.

**Acceptance criteria**

- `/dashboard/shifts` renders the list, search/sort/paginate/view-toggle all update
  the URL.
- Open dialog requires selecting a branch and entering opening cash; submitting
  succeeds and the list refreshes.
- Close button appears only on the caller's own open shift row; submitting closes
  it and the list refreshes with `actualCashAmount` shown and expected/variance
  showing "—".
- Attempting a second open in the same branch surfaces the 409 as a toast error.
- No raw HTML chrome introduced in `apps/chrono-web`.

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 5), shared branch-context switcher, module-registry
gating.

**Execution start point:** create `apps/chrono-web/src/app/dashboard/shifts/
page.tsx`.

---

## Phase 5 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/shifts/shifts.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring `apps/chrono-web/e2e/tests/branches/
   branches.spec.ts`'s structure and `signUp()` helper. Because `shift:open`/
   `shift:close` are granted to **every** tenant role (no admin-only action exists
   in this module — see Pass 2), the standard "role gate" template case doesn't
   apply as a staff-vs-admin split. Cover instead:
   - **Happy path**: sign up a tenant, create a branch (reuse the `branches` flow
     or seed one directly), navigate to `/dashboard/shifts`, open a shift (select
     the branch, enter opening cash), confirm it lists as `open`, close it (enter
     actual cash), confirm it lists as `closed` with the entered actual cash and
     "—" for expected/variance.
   - **Business-rule gate** (this module's substitute for the role-gate case):
     attempting to open a **second** shift in the same branch while one is already
     open for the same staff account surfaces the 409 as a toast error and no
     second row is added — proves the guard, which every role is otherwise equally
     subject to.
   - **Tenant isolation**: tenant A opens a shift at their branch; tenant B's shift
     list (search/filter included) never shows it, and tenant B attempting to close
     tenant A's shift id gets a 404-driven toast.
2. Use `@faker-js/faker` for names/emails/slugs (`.ai/rules/e2e-testing.md`) — not
   hand-rolled `Date.now()` strings.

**Acceptance criteria**

- All three cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config).
- No `.env` present in `apps/chrono-api` while running.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/shifts/
  shifts.spec.ts` (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage (no platform-admin routes for shifts
in this pass); any assertion on `expectedCashAmount`/`differenceAmount` math (always
null in this pass — nothing to assert).

**Execution start point:** create `apps/chrono-web/e2e/tests/shifts/shifts.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/shifts/` to
`.ai/plans/chrono/archive/shifts/` once all five phases are verified and committed
separately.
