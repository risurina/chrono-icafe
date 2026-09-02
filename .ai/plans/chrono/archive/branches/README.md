# Chrono — `branches` module

**Depends on:** none (Wave 1 root). **Status: ready to implement now**, in parallel
with the separately-planned `members` module — `branches` and `members` are the only
two Wave-1 modules with no dependency on another Wave-1 module. `stations` and `shifts`
depend on `branches`; `devices` depends on `stations`; `sessions` depends on
`stations` + `members` + `wallet`.

## What this is

Branches are the venue locations a Chrono tenant operates (internet-café/gaming-center
sites). It is the root of the Chrono domain — nothing else in Wave 1 references
anything until `branches` exists.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Owner / Admin** — create branches, edit branch details (address, contact,
  timezone, coordinates, hours, social links), and enable/disable a branch. This is
  tenant configuration, the same tier as domains/branding/integrations in the
  foundation, not an owner-only lifecycle action.
- **Staff** — read-only. A staff member needs to see the branch list (e.g. to pick a
  branch context for a future station/session/shift action) but cannot create, edit,
  or disable a branch.
- **Platform admin (`/rpc-admin`)** — not built in this pass. Out of scope (see
  "Out of Scope" below).

**Workflow:** Owner/Admin opens **Dashboard → Branches**, sees a paginated/searchable
list, clicks **Add Branch**, fills a form (name required, everything else optional,
code auto-generated from name if left blank), saves. The new branch appears
immediately. Editing follows the same dialog, pre-filled. Disabling a branch is a
status flip (`active` → `disabled`), not a delete — Chrono never hard-deletes a branch
in this pass (no downstream module exists yet whose rows would need to cascade or be
reassigned).

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Staff attempts create/update → 403 `Forbidden`, gated by `requirePermission`.
- Duplicate `code` within a tenant → 409 (unique per `(tenantId, code)`).
- Wrong tenant/host → `tenantMiddleware()` never resolves a `c.var.tenant`, so the
  request never reaches the handler.
- **Tenant-isolation leak scenario**: tenant A creates a branch named "Main Branch"
  with code `main`; tenant B (which also happens to name a branch "Main Branch") must
  never see tenant A's row in its list, must get 404 (not 403 — never confirm
  existence) editing tenant A's branch id directly, and the `(tenantId, code)` unique
  index must not falsely conflict across tenants (it's a composite, not a bare `code`
  unique, so this is a schema-level guarantee, not just an RLS one).
- Stale screen: two admins editing the same branch — last write wins (no optimistic
  lock in this pass, matching `project`'s own simplicity).

**Audit / notifications:** every create/update writes a `recordStaffAudit` audit-log
entry (`branch.created` / `branch.updated`), matching the `project`/`customer` pattern.
No email/webhook notification in this pass (branch changes aren't currently in
`WEBHOOK_EVENTS`; adding one is a trivial follow-up, not required for Wave 1).

---

## Pass 2 — Technical Planning

### What exists today in oikos (source of truth for "what exists")

- `apps/chrono-api/src/modules/branches/routes.ts` (oikos) — Hono routes:
  `GET /all` (super-admin cross-tenant list), `PATCH /:id/status` (super-admin),
  `GET /` (tenant list — owner/admin see all branches, staff see only branches they
  have `UserBranchAccess` rows for), `POST /` (owner-only create, auto-generates
  `code` from `name` via `generateBranchCode()`), `PATCH /:id` (owner-only update).
  Role gate is `requireRole(['SUPER_ADMIN', 'OWNER'])` — oikos's tenant role ladder
  is only `OWNER`/`STAFF` (the other role strings in that file are platform-level
  admin roles, not tenant roles), so branch CRUD is effectively owner-only there.
- `apps/chrono-api/src/modules/branches/dto.ts` (oikos) — Zod schemas:
  `createBranchSchema`/`updateBranchSchema` (name, code, status `ACTIVE`/`DISABLED`,
  address, contactNumber, email, operatingHours, timezone, latitude, longitude,
  googleMapsUrl, socialLinks `{facebook, messenger, instagram, tiktok, discord}`).
- `apps/chrono-api/src/database/schema/tenant.ts` (oikos) — `Branch` table
  (`Branches`, uuid PK, `tenantId` FK, `name`, `code`, `address`, `contactNumber`,
  `timezone` default `Asia/Manila`, `status` enum, `latitude`/`longitude` as varchar,
  a single `metadataJson` jsonb blob holding `googleMapsUrl`/`socialLinks`/`email`/
  `operatingHours`), unique `(tenantId, code)`. Also `UserBranchAccess`
  (`UserBranchAccesses`: `userId`, `tenantId`, `branchId`, `roleId` → a DB-driven
  `TenantRole`) — used **only** for read-time gating in
  `apps/chrono-api/src/middleware/auth.ts` (STAFF branch-scoping check). **No CRUD
  routes exist for it anywhere in oikos** (`grep` across `chrono-api/src` and
  `chrono-web/src` found zero create/update call sites) — it's schema with no admin
  surface.
- `apps/chrono-web/src/app/tenant/admin/(authenticated)/(tenant)/branches/` (oikos) —
  `page.tsx` (server component, paginated list), `branches-client.tsx` (create/edit
  dialogs + `DataTable`, status radio Active/Inactive, social-links sub-form,
  "Archive" destructive action), `actions.ts` (server actions calling
  `@/lib/tenant-branches`), `select-action.ts` (sets a `x-chrono-branch-id` cookie for
  a separate "current branch" context switcher — belongs to a future per-branch
  routing concern, not this module).
- `apps/chrono-web/src/lib/tenant-branches.ts` (oikos) — REST client
  (`listBranches`, `listBranchesPaginated`, `createBranch`, `updateBranch`); its
  `BranchStatus` type includes `"archived"` but the API only ever accepts
  `ACTIVE`/`DISABLED` — the web-side "Archive" action actually just sets
  `status: DISABLED` server-side. Dead/misleading tri-state on the client; not carried
  into agora.

### Pattern to copy in agora (worked example: `project`)

- `apps/chrono-api/src/db/schema.ts` — `project` table definition + `APP_TENANT_TABLES`
  array (flat scaffold layout).
- `apps/chrono-api/src/routes/rpc.ts` — `project` GET (ungated list, paginated via
  `listQuerySchema`)/POST (`requirePermission(..., { project: ["create"] })`)/DELETE
  (`requirePermission(..., { project: ["delete"] })`), all through
  `withTenant(tenantId, tx => …)`, each mutation followed by `recordStaffAudit` +
  `emitTenantEvent`.
- `apps/chrono-web/src/app/dashboard/projects/page.tsx` — `useListQuery()` for URL
  state, `api.rpc.projects.$get/$post/$delete` typed client calls,
  `DataTable`/`DataTableGrid`/`DataTableToolbar`/`DataTablePagination` from `agora/ui`.
- `.ai/rules/business-app.md` — **Chrono does NOT use the flat scaffold layout.**
  Business domains live under `apps/chrono-api/src/modules/<domain>/` (`schema.ts` +
  `contracts.ts` + `routes.ts` + tests), and `apps/chrono-api/src/db/schema.ts` /
  `apps/chrono-api/src/routes/rpc.ts` only *compose* each module — this is the one
  structural difference from the `project` example, which lives in the flat scaffold.
  Per business-app.md, module contracts stay in the module's own `contracts.ts`
  (promote to `packages/agora/src/contracts` only if a second business app needs
  them) — this **narrows** `.ai/rules/dto.md`'s "contracts live in `packages/agora`"
  for the business-app case specifically.
- `apps/chrono-api/src/modules/README.md` — confirms the module folder is currently
  empty and describes exactly this convention; **delete this file** once this module
  lands (its own instruction).
- `.ai/rules/rbac.md` / `apps/chrono-api/src/auth/permissions.ts` —
  `CHRONO_PERMISSION_STATEMENTS` vocabulary + `staffRole`/`adminRole` composition,
  registered via `registerAppPermissions()` (see Open Question 1 below for the
  one real judgment call in this plan).

### Schema — `ChronoBranches`

New file `apps/chrono-api/src/modules/branch/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoBranch = pgTable(
  "ChronoBranches",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    status: text("status").notNull().default("active"), // "active" | "disabled"
    address: text("address"),
    contactNumber: text("contactNumber"),
    email: text("email"),
    timezone: text("timezone").notNull().default("Asia/Manila"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    operatingHours: text("operatingHours"),
    googleMapsUrl: text("googleMapsUrl"),
    socialLinks: jsonb("socialLinks").$type<{
      facebook?: string | null;
      messenger?: string | null;
      instagram?: string | null;
      tiktok?: string | null;
      discord?: string | null;
    } | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_branch_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_branch_tenant_code_idx").on(t.tenantId, t.code),
  ],
);
```

Deliberate differences from the oikos `Branch` table:

- `text`/`createId()` id, not `uuid`/`defaultRandom()` (foundation ID convention).
- `status` is free-text (`"active"`/`"disabled"`) enforced at the Zod layer, not a
  Postgres enum — matches the dominant agora convention (`storedFile.status`,
  `tenantMember.status`) over `pgEnum`, and sidesteps the non-idempotent
  `CREATE TYPE` migration ceremony for a two-value field.
  `email`/`operatingHours`/`googleMapsUrl` are promoted to explicit columns instead
  of buried in oikos's single `metadataJson` blob (`database.md`: jsonb only for
  true extensibility); `socialLinks` stays `jsonb` since it's a genuinely open-ended
  small object.
- No `archived` status. oikos's web layer had one (dead — the API never accepted it);
  agora keeps the real two-value truth (`active`/`disabled`). No `deletedAt` either —
  nothing hard-deletes a branch in this pass (see CRUD matrix below).
- **No `UserBranchAccess`-equivalent table.** See Open Question 3.

### `APP_TENANT_TABLES`

Add `"ChronoBranches"` to the array in `apps/chrono-api/src/db/schema.ts`, and
re-export `chronoBranch` from the module into that file (composition point per
business-app.md).

### Contracts — `apps/chrono-api/src/modules/branch/contracts.ts`

```ts
import { z } from "zod";

export const branchStatusSchema = z.enum(["active", "disabled"]);

const branchSocialLinksSchema = z
  .object({
    facebook: z.string().url().max(2048).nullable().optional(),
    messenger: z.string().url().max(2048).nullable().optional(),
    instagram: z.string().url().max(2048).nullable().optional(),
    tiktok: z.string().url().max(2048).nullable().optional(),
    discord: z.string().url().max(2048).nullable().optional(),
  })
  .optional();

export const createBranchSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50).optional(), // auto-generated from name when omitted
  status: branchStatusSchema.optional(),
  address: z.string().max(255).optional(),
  contactNumber: z.string().max(50).optional(),
  email: z.string().email().max(255).optional(),
  operatingHours: z.string().max(255).optional(),
  timezone: z.string().min(1).max(50).optional(),
  latitude: z.string().max(20).optional(),
  longitude: z.string().max(20).optional(),
  googleMapsUrl: z.string().url().max(2048).optional(),
  socialLinks: branchSocialLinksSchema,
});

export const updateBranchSchema = createBranchSchema.partial();

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type BranchStatus = z.infer<typeof branchStatusSchema>;
```

Code generation (`generateBranchCode`) is ported verbatim from oikos's routes.ts
(lowercase, non-alnum → `-`, collapse/trim dashes) into
`apps/chrono-api/src/modules/branch/routes.ts` as a local helper.

### Routes — `apps/chrono-api/src/modules/branch/routes.ts`

A Hono factory `branchRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/branches", branchRoutes())`:

- `GET /` — **ungated** (any authenticated tenant member/role can list — matches the
  `project` GET pattern; staff need read access to branches for future
  station/session context). `zValidator("query", listQuerySchema(["name", "code",
  "createdAt"]))`, `withTenant`, returns `{ items, meta }` (`buildPaginationMeta`
  pattern from `apps/chrono-api/src/routes/rpc.ts`, ported into the module or reused
  via import if the parent file keeps exporting it).
- `POST /` — `requirePermission(c.var.tenant.permissions, { branch: ["create"] })`.
  Validates `createBranchSchema`. Generates `code` from `name` when omitted. On a
  `(tenantId, code)` conflict, return 409 (`A branch with that code already exists`).
  `withTenant` insert, `recordStaffAudit({ action: "branch.created", ... })`.
- `PATCH /:id` — `requirePermission(c.var.tenant.permissions, { branch: ["update"] })`.
  Validates `updateBranchSchema` (partial — covers both detail edits and the
  active/disabled status flip in one endpoint, matching oikos's single PATCH and
  avoiding a speculative separate `branch:archive` action for a plain status field).
  404 if the branch doesn't belong to the caller's tenant (RLS + explicit
  `eq(chronoBranch.id, id)` inside `withTenant` — a foreign id is simply not found,
  never a 403, so existence is never leaked cross-tenant). `recordStaffAudit({ action:
  "branch.updated", ... })`.

No `DELETE /branches/:id` in this pass (see CRUD matrix).

### Permission vocabulary

The resource is registered through the **per-app extension seam**, never by editing
`packages/agora` — see `.ai/rules/business-app.md` ("Permissions: the per-app extension
seam") and root `AGENTS.md` non-negotiable #6. This module does not touch
`packages/agora` at all.

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  branch: ["create", "update"],
} satisfies Record<string, string[]>;
```

These are registered via `registerAppPermissions()` from
`apps/chrono-api/src/auth-bootstrap.ts`, which every process entrypoint imports before
anything imports `agora/auth`. Route files gate through the app-local typed wrapper
`apps/chrono-api/src/auth/require-permission.ts`.

- `staffRole` — **not added** (read-only via the ungated GET; no staff-level branch
  mutation exists, matching the file's own principle that an unused statement invites
  drift).
- `adminRole` — `branch: ["create", "update"]` (branch management sits alongside
  `domain`/`branding`/`integration` as core tenant configuration, not tenant lifecycle
  or billing, so it follows their admin+ tier rather than oikos's owner-only gate —
  see Open Question 2).
- `ownerRole` — inherits automatically (owner holds every statement by construction).

**Open Question 2:** oikos gated branch CRUD `OWNER`-only (no tenant "admin" tier
existed there). This plan widens it to **admin+** to match agora's sibling
configuration resources. If the developer wants to preserve oikos's stricter
owner-only behavior instead, drop `branch: [...]` from `adminRole` and the action set
becomes owner-exclusive by construction (owner still holds it via `PERMISSION_STATEMENTS`
directly). This is a one-line change in Phase 3 either way — flagging it now so it's a
deliberate choice, not a default nobody noticed.

**Open Question 3:** oikos's `UserBranchAccess` (staff-scoped branch visibility) has
**zero CRUD surface anywhere in oikos** — it's schema with no admin UI, populated by
some process not found in either app tree. agora's RBAC is tenant-level only
(staff/admin/owner); there's no per-branch role concept to port. This plan
**deliberately excludes** a `ChronoStaffBranchAccess`-equivalent table: building
unused schema ahead of a real requirement contradicts `ai-agent.md` ("do not create
business-specific modules unless requested") and the RBAC file's own "unused
statement/table invites drift" principle. Recommendation: defer this decision to
whichever later-wave module (`stations` or `sessions`) first needs to restrict staff
to specific branches, and design it against that module's actual read/write patterns
instead of speculatively now. Flagging so the developer can override if per-branch
staff scoping is actually wanted in Wave 1.

### Web UI — `apps/chrono-web/src/app/dashboard/branches/`

- `page.tsx` — client component (mirrors `apps/chrono-web/src/app/dashboard/projects/page.tsx`
  exactly): `useListQuery()` for URL-driven page/pageSize/q/sort/order/view,
  `api.rpc.branches.$get({ query: {...} })`, `DataTable`/`DataTableGrid` +
  `DataTableToolbar` + `DataTablePagination` from `agora/ui`.
- A create/edit form uses a `Dialog` (`agora/ui` — already has `dialog.tsx`,
  `select.tsx`, `input.tsx`, `label.tsx`, `textarea.tsx`) — **not** oikos's
  `RadioGroup`/`Checkbox` (not present in `packages/agora/src/ui/components/ui/`
  today); use `Select` for the `active`/`disabled` status field instead. If a genuinely
  needed primitive is missing, add it to `packages/agora/src/ui` first per
  `ai-agent.md` — do not invent a local wrapper in `apps/chrono-web`.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Branches` entry to
  `BASE_NAV` (a `Building`/`MapPin`-style `lucide-react` icon) and a
  `"/dashboard/branches": "Branches"` line to `TITLES`, mirroring the existing
  `Projects` entries exactly (lines 47 and 73 in the current file).
- No `[branchCode]`-style per-branch route segment in this pass — that routing shape
  belongs to whichever later module (`stations`, `sessions`, etc.) actually needs a
  "current branch" context switcher; out of scope here (see Out of Scope).
- No module-registry feature-flag gate (unlike `Projects`, which is gated by
  `modules.project`) — branches are core to every Chrono tenant, not an optional
  module. Confirm this reading with the developer if a kill-switch is wanted anyway.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List | `GET /rpc/branches` | none (any tenant member) | paginated, searchable by name/code |
| Create | `POST /rpc/branches` | `branch:create` | 409 on duplicate `(tenantId, code)` |
| Update (incl. status) | `PATCH /rpc/branches/:id` | `branch:update` | 404 cross-tenant |
| Delete | — | — | **not built this pass** — disabling (`status: "disabled"`) is the only "removal"; no hard delete exists (nothing downstream to cascade/reassign yet) |

Feedback: `toast.success`/`toast.error` at the point of the API call (per
`.ai/rules/ui.md`'s `Toaster` guidance), matching the `Projects` page's inline
`toast.error("Could not create project.")` pattern — no separate `<FormError>`.

Audit linkage: `recordStaffAudit` on create/update, same as `project`/`customer`;
no separate confirmation dialog required for a status-only PATCH (not destructive —
recoverable by flipping status back).

### Out of Scope (this plan)

- The `/rpc-admin` platform-admin cross-tenant branch view/override (oikos's
  `GET /all` + `PATCH /:id/status` super-admin routes). Nothing in `.ai/rules/rbac.md`'s
  `PLATFORM_PERMISSION_STATEMENTS` names a `branch` resource today; adding one is a
  separate, later plan if platform staff need it.
  - **A read-only branch view already exists indirectly**: platform admins can see a
    tenant's data via the existing `organization` resource surfaces — a Chrono-specific
    branch drill-down is net-new scope, not implied by this plan.
- `ChronoStaffBranchAccess` / per-branch staff scoping (Open Question 3).
- The `[branchCode]` URL-segment "current branch" context switcher and its cookie
  (oikos's `select-action.ts` / `x-chrono-branch-id`) — belongs to whichever module
  first needs a branch-scoped UI (stations/sessions), not to branch CRUD itself.
- A `branch.created`/`branch.updated` webhook event — trivial follow-up, not required
  to ship this module; add to `WEBHOOK_EVENTS` in a later pass if a tenant asks for it.
- Module-registry (`modules.branch`) feature-flag gating of the nav entry.
- Any `stations`/`shifts`/`devices` code — those are separate, dependent plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/branch/schema.ts` (new) — `chronoBranch` table (see
  Pass 2 above).
- `apps/chrono-api/src/db/schema.ts` — import + re-export `chronoBranch`, add
  `"ChronoBranches"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/branch/` and write `schema.ts` exactly as
   specified in Pass 2 (table name `"ChronoBranches"`, both indexes).
2. In `apps/chrono-api/src/db/schema.ts`, add `export { chronoBranch } from
   "../modules/branch/schema";` (or a named re-export matching the file's existing
   style) and append `"ChronoBranches"` to the `APP_TENANT_TABLES` tuple.
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_branches` (never
   `db:push` — `.ai/rules/database.md`). Review the generated SQL: expect a single
   `CREATE TABLE "ChronoBranches"` plus its two indexes, no destructive statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN` (applies
   the migration and re-asserts `FORCE ROW LEVEL SECURITY` on every
   `APP_TENANT_TABLES` entry, `ChronoBranches` included).

**Acceptance criteria**

- `ChronoBranches` exists in the target database with `FORCE ROW LEVEL SECURITY` on.
- `"ChronoBranches"` is present in `APP_TENANT_TABLES` in
  `apps/chrono-api/src/db/schema.ts`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`. (The
  proof exercises the generic RLS mechanism via the existing `project` table; it does
  not need a `ChronoBranches`-specific assertion to prove this table's isolation —
  the same forced-RLS policy machinery applies uniformly to every
  `APP_TENANT_TABLES` entry.)

**Out of scope:** contracts, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/branch/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/branch/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `branchStatusSchema`, `createBranchSchema`, `updateBranchSchema` and their
   `z.infer` types exactly as specified in Pass 2.
2. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- `CreateBranchInput`/`UpdateBranchInput`/`BranchStatus` types compile and are
  importable from `../modules/branch/contracts` inside `apps/chrono-api`.
- `updateBranchSchema` accepts a `status`-only payload (the disable/enable path) and a
  full-field payload (the edit-dialog path) with no field required.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/branch/contracts.ts`.

---

## Phase 3 — Routes + permission gates

**Files to update**

- `apps/chrono-api/src/auth/permissions.ts` — add `branch: ["create", "update"]` to
  `CHRONO_PERMISSION_STATEMENTS` and to `adminRole`, registered via
  `registerAppPermissions()` in `apps/chrono-api/src/auth-bootstrap.ts`. **Never
  `packages/agora`** — see `.ai/rules/business-app.md`, "Permissions: the per-app
  extension seam". (Resolve Open Questions 1 & 2 first — see Pass 2.)
- `apps/chrono-api/src/modules/branch/routes.ts` (new) — `branchRoutes()` factory.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/branches", branchRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add a `branch` gate case (staff
  denied `create`/`update`, admin/owner allowed), mirroring the existing `project`
  cases in that file's "behaviour preservation" style.

**Step-by-step tasks**

1. Add `branch: ["create", "update"]` to `CHRONO_PERMISSION_STATEMENTS` in
   `apps/chrono-api/src/auth/permissions.ts`, and to `adminRole`'s composed statement
   object (owner inherits automatically; `staffRole` gets nothing, per Open
   Question 1's resolution).
2. Write `apps/chrono-api/src/modules/branch/routes.ts`: `GET /` (ungated, paginated
   via `listQuerySchema(["name", "code", "createdAt"])`), `POST /`
   (`requirePermission(..., { branch: ["create"] })`, code auto-generation, 409 on
   duplicate code, `withTenant` insert, `recordStaffAudit`), `PATCH /:id`
   (`requirePermission(..., { branch: ["update"] })`, `withTenant` update scoped to
   `and(eq(chronoBranch.id, id))` inside the tenant transaction, 404 if not found,
   `recordStaffAudit`). Follow the exact structure of the `project`/`customer` blocks
   in `apps/chrono-api/src/routes/rpc.ts` (import style, `HttpError`, pagination meta
   shape).
3. Compose into `apps/chrono-api/src/routes/rpc.ts` via
   `.route("/branches", branchRoutes())`.
4. Add a `branch` case to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { branch: ["create"] }) === false`,
   `hasPermission("admin", { branch: ["create"] }) === true`,
   `hasPermission("owner", { branch: ["create"] }) === true` (and the same for
   `"update"`).

**Acceptance criteria**

- `GET /rpc/branches` returns `{ items, meta }` for any authenticated tenant member.
- `POST /rpc/branches` as staff → 403; as admin/owner → 201 with the created row.
- Duplicate `code` within the same tenant → 409; the same `code` in a different tenant
  succeeds (composite unique index proven, not a global one).
- `PATCH /rpc/branches/:id` on another tenant's branch id → 404 (never 403 — no
  existence leak).
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `branch`
  cases included.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out of scope:** UI, e2e browser spec (Phase 5).

**Execution start point:** edit `apps/chrono-api/src/auth/permissions.ts` first (the
routes file imports `requirePermission` against the new resource, so the vocabulary
must exist before the route file typechecks).

---

## Phase 4 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/branches/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected; `Dialog`/`Select`/`Input`/`Label`/`Textarea` already exist).

**Step-by-step tasks**

1. Build `page.tsx` mirroring `apps/chrono-web/src/app/dashboard/projects/page.tsx`:
   `useListQuery()`, `api.rpc.branches.$get/$post/$patch` typed calls,
   `DataTable`/`DataTableGrid` + `DataTableToolbar` + `DataTablePagination`.
2. Add a create/edit `Dialog` form: `name` (required), `code` (optional, placeholder
   "generated from name"), `status` (`Select`: Active/Disabled), `address`,
   `contactNumber`, `email`, `timezone`, `latitude`/`longitude`, `operatingHours`,
   `googleMapsUrl`, and the five social-link fields — all via `agora/ui` primitives
   only (`.ai/rules/component-first-ui.md` — no raw `<div>`/`<input>` in
   `apps/chrono-web`).
3. Wire `toast.success`/`toast.error` on create/update, matching the `Projects` page's
   inline-error convention (no `<FormError>`).
4. Add `{ type: "item", name: "Branches", href: "/branches", icon: <pick an
   appropriate lucide-react icon> }` to `BASE_NAV` in
   `apps/chrono-web/src/app/dashboard/layout.tsx`, and `"/dashboard/branches":
   "Branches"` to `TITLES`.

**Acceptance criteria**

- `/dashboard/branches` renders the list, search/sort/paginate/view-toggle all update
  the URL (same behavior as `/dashboard/projects`).
- Create/edit dialogs submit successfully and the list refreshes.
- A staff-role session sees the list but gets a toast error attempting create (the
  server 403 surfaces client-side, mirroring the `Projects` page's "Only admins can
  delete projects." pattern).
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 5), `[branchCode]` routing, module-registry gating.

**Execution start point:** create `apps/chrono-web/src/app/dashboard/branches/page.tsx`.

---

## Phase 5 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/branches/branches.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring
   `apps/chrono-web/e2e/tests/data-listing/projects-listing.spec.ts`'s structure and
   `signUp()` helper, covering three cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant, navigate to `/dashboard/branches`, create a
     branch (name only — confirms auto-generated `code`), edit it (confirms `PATCH`),
     disable it via the status field, confirm the row still lists (disabled ≠
     deleted).
   - **Role gate**: owner creates a branch, invites a staff teammate (reuse the
     invite-link flow from `projects-listing.spec.ts`), staff can view the list but
     attempting create surfaces a 403-driven toast and no row is added.
   - **Tenant isolation**: tenant A creates "Acme Only Branch"; tenant B's branches
     list (search included) never shows it.
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts` if present, else the
   shared helper referenced in `.ai/rules/e2e-testing.md`) for slugs/emails/names —
   not hand-rolled `Date.now()` strings, matching the rule's explicit requirement
   (note: the existing `projects-listing.spec.ts` itself still uses `Date.now()` —
   follow the *rule*, not that file's precedent, for new specs).

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (this suite is manual/headed
  per `.ai/rules/rbac.md`'s "Testing" section — no `webServer` in the Playwright
  config).
- No `.env` present in `apps/chrono-api` while running (the spec drives the real dev
  server, not the in-process PGlite harness).

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/branches/branches.spec.ts`
  (with `pnpm dev` already running, per `.ai/rules/rbac.md`'s manual-suite note).

**Out of scope:** platform-admin e2e coverage (no platform-admin routes exist for
branches in this pass).

**Execution start point:** create
`apps/chrono-web/e2e/tests/branches/branches.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/branches/` to
`.ai/plans/chrono/archive/branches/` once all five phases are verified and committed
separately. Delete `apps/chrono-api/src/modules/README.md` once this module lands (its
own stated instruction — but only if `branches` is genuinely the first module to land;
check for a concurrently-landed `members` module first since both are unblocked in
parallel).
