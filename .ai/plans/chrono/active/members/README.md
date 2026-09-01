# Chrono — `members` module

**Depends on:** the foundation's `tenantMember` (`TenantMembers`) only — no dependency
on another Wave-1 Chrono module. **Status: ready to implement now**, in parallel with
the separately-planned `branches` module — `branches` and `members` are the only two
Wave-1 modules with no dependency on another Wave-1 module (`.ai/handover/chrono-migration.md`).
`wallet` and `sessions` depend on this plan's output.

## What this is

Chrono's venue members — the customer-facing accounts a tenant's gaming/internet-café
patrons use to sign up, get approved by staff, and (later, once `wallet`/`sessions`
land) top up a balance and run timed sessions. This plan does **not** build a new
identity/auth system: the foundation's `tenantMember` (`packages/agora/src/db/schema/tenant.ts`)
already **is** that pool — self-service email/password sign-up, its own sessions, and a
full staff-facing admin CRUD surface (`customer` permission resource, `/rpc/customers`
routes) that ships with the scaffold clone and needs zero changes. This plan's real job
is narrower: a Chrono-owned `ChronoMemberProfiles` table (FK to `tenantMember.id`) for
the venue-specific fields oikos's member data has beyond identity, plus the staff
approve/reject workflow and the customer-facing "apply for membership" flow that go with
it. See "Critical scope finding" in Pass 2 for the evidence this is based on.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Customer (portal)** — signs up at `{slug}.APP_DOMAIN/portal/sign-up` (foundation,
  unchanged — already live), then, once signed in, applies for venue membership from
  `/portal` (new: this plan). Views their own application status (pending / approved /
  rejected) and phone number.
- **Staff / Admin / Owner** — sees the existing generic "Customers" identity list
  (`/dashboard/settings/customers`, unchanged) for account-level actions (suspend,
  export, delete — DSAR), and a new, Chrono-specific **Members** list
  (`/dashboard/members`) showing the venue fields: phone, application status,
  applied/approved/rejected timestamps. Approves or rejects a pending application;
  edits phone.
- **Platform admin (`/rpc-admin`)** — not built in this pass, same as `branches`. Out of
  scope.

**Workflow:** A customer signs up via the foundation's existing `/portal/auth/sign-up`
(unchanged — creates an `active` `tenantMember` immediately, matching every other agora
tenant's customer signup). On first visit to `/portal` they see an "Apply for
membership" prompt; submitting creates their `ChronoMemberProfiles` row with
`applicationStatus: "pending"`. Staff see the new application in **Dashboard → Members**
and click Approve or Reject. The customer's `/portal` page reflects the current status
on next load. A directly-staff-created customer (`POST /rpc/customers`, existing,
unchanged) is auto-approved — an admin creating an account is itself the approval act
(see Open Question 1).

**Failure cases:**

- Unauthenticated customer hitting `/portal` → the foundation's `memberMiddleware()`
  401s before any Chrono code runs.
- Unauthenticated/wrong-tenant staff request → `tenantMiddleware()` never resolves
  `c.var.tenant`; the route never runs.
- A `member`-role... n/a — Chrono has no `member`-rank; the relevant floor here is
  `staff`. A `staff` session attempting approve/reject → 403, gated by
  `requirePermission`.
- Double-apply: a customer who already has a `ChronoMemberProfiles` row calling apply
  again → idempotent, returns the existing row unchanged (no duplicate, no re-triggered
  email) — mirrors oikos's own idempotent-apply behavior.
- Approve/reject on a `memberId` that doesn't belong to the caller's tenant → 404, never
  403 (no existence leak — RLS + explicit tenant-scoped lookup inside `withTenant`).
- **Tenant-isolation leak scenario**: tenant A's customer applies for membership; tenant
  B's `/dashboard/members` list must never show that row (RLS on `ChronoMemberProfiles`
  is the primary guarantee — same mechanism `rls:proof` already exercises generically),
  and tenant B staff hitting tenant A's `memberId` directly on the approve/reject routes
  gets 404.
- Stale screen: two staff approving the same application — last write wins (no
  optimistic lock in this pass, matching `branches`' own simplicity call).

**Audit / notifications:** every apply/approve/reject writes a `recordStaffAudit`
entry — `chronoMemberProfile.applied` / `.approved` / `.rejected` (see "Audit action
naming" in Pass 2 for why the prefix is `chronoMemberProfile`, not `member`). No
transactional email in this pass — oikos sends one at every status transition via a
per-instance Resend provider; Chrono can wire the same moments through
`agora/server`'s `renderBrandedEmail`/`sendTransactionalEmail` (already used by
`agora/member-auth` for password reset) as a trivial follow-up, but it is not required
to ship the workflow itself (see Out of Scope).

---

## Pass 2 — Technical Planning

### Critical scope finding (read this before the schema)

Two things this plan would otherwise get wrong if assumed instead of read:

1. **The `customer` permission resource and a full `/rpc/customers` CRUD surface
   already exist and need no changes.** `packages/agora/src/auth/permissions.ts`
   already defines `customer: ["read", "create", "update", "suspend", "reactivate",
   "export", "delete"]`, granted to `admin`/`owner` (not `staff`). And
   `apps/chrono-api/src/routes/rpc.ts` — currently a byte-identical, unmodified clone of
   `apps/agora-api/src/routes/rpc.ts` (confirmed: `diff` between the two files is
   empty) — already has full working `GET/POST/PATCH /customers`,
   `POST /customers/:id/suspend`, `POST /customers/:id/reactivate`,
   `GET /customers/:id/export`, `DELETE /customers/:id` handlers, all `withTenant`-scoped
   against `base.tenantMember`, all audited. `apps/chrono-web/src/app/dashboard/settings/customers/page.tsx`
   is the matching working admin UI, also already cloned in, unmodified. **Chrono is not
   the first consumer of `tenantMember`+`customer` — it's reusing a route surface the
   scaffold already ships.** Nothing in this plan touches those files; they are called
   out only so the next phase doesn't rebuild them.
2. **The foundation's `agora/member-auth`** (`packages/agora/src/member-auth/index.ts`)
   already provides self-service customer sign-up/sign-in/forgot/reset, mounted at
   `/portal/auth/*` (`apps/chrono-api/src/app.ts`, also unmodified), and a customer
   portal shell already exists at `apps/chrono-web/src/app/portal/**` (sign-up, login,
   forgot, reset, and a `page.tsx` whose own comment reads "Placeholder — extend with
   your customer-facing features"). This plan extends that placeholder; it does not
   build portal auth from scratch.

### What exists today in oikos, and how it maps

- `apps/chrono-api/src/database/schema/members.ts` (oikos) — `TenantMember` (**not**
  the same concept as agora's `tenantMember`, despite the identical name — see "Naming
  collision" below). oikos's identity pool is a single, tenant-agnostic `User` table
  shared by staff and customers alike; `TenantMember` is the per-tenant *membership*
  row joining a `User` to a tenant with `tenantRoleId`, `status`
  (`PENDING`/`APPROVED`/`REJECTED`/`SUSPENDED`), `memberCode`, `joinedAt`/`approvedAt`/
  `rejectedAt`/`suspendedAt`, and a `metadataJson` bag holding `phone`, `source`, and
  the applied-to `applicationBranchId`/`applicationBranchCode`.
- `apps/chrono-api/src/modules/members/` (oikos) — the **self-service application**
  workflow: `GET /application/branches` (public), `GET /application` (own status),
  `POST /application` (apply — always forces `PENDING`, requires picking one of the
  tenant's active branches), `PATCH /:memberId/status` (staff-only approve/reject/
  suspend/reinstate, `requireRole(['OWNER','STAFF'])`). Sends a
  `ResendEmailProvider` email at every transition.
- `apps/chrono-api/src/modules/customers/` (oikos) — the **staff-facing admin
  CRUD/search** over the same `TenantMember`+`User` rows: branch-scoped list with
  search/status filter (joined with `Wallet.balance` and the customer's live
  `DeviceSession`/`Station` — both belong to modules not built yet), `GET /:id` detail,
  `PATCH /:id` (name/phone/status), `POST /` (staff-created customer, auto-`APPROVED`),
  plus customer-facing `POST /join` (visit-history ping), `GET /me`, `GET /history`
  (`UserTenantHistory` — branch visit log).
- **Answer to "same concept split across two folders, or genuinely different?"**: the
  **same underlying rows** (`TenantMember` + `User`), split by **audience**, not by
  data model — `members/` is the customer's own self-service application surface,
  `customers/` is staff's admin/search/CRM surface over the identical table. There is
  no separate "loyalty enrollee vs. broader CRM" distinction in oikos; that split lives
  entirely in the still-deferred `loyalty` module (`apps/chrono-api/src/database/schema/loyalty.ts`,
  `apps/chrono-api/src/modules/loyalty/` — grepped: no `tier`/`tags`/`notes` fields on
  the member row itself; loyalty tiers/points are their own tables this plan does not
  touch).
- **Naming collision worth flagging explicitly**: oikos's `TenantMember` is analogous
  to agora's **staff** `member` (Better Auth org membership — role + status on a
  tenant), not to agora's `tenantMember` (the customer identity pool). agora already
  separates these two concerns into two differently-named tables; oikos conflates them
  under one name reused for a different purpose than agora's `tenantMember`. This plan
  follows agora's separation — `ChronoMemberProfiles` extends agora's customer-identity
  `tenantMember`, and never touches Better Auth's staff `member` table.
- `apps/chrono-web/src/app/member/onboarding/page.tsx`, `signup/`, `profile/` +
  `apps/chrono-web/src/lib/member-application.ts` (oikos) — the self-service branch
  picker + apply/status UI. `apps/chrono-web/src/app/tenant/admin/(authenticated)/[branchCode]/customers/**`
  (oikos) — the staff list/detail/manage-dialog, whose "manage" dialog's wallet/credits/
  loyalty tabs belong to modules this plan doesn't build (`wallet`, `loyalty`).

### memberCode — deliberately not ported

oikos's `TenantMember.memberCode` (`varchar(64)`, with a `(tenantId, memberCode)`
unique index) is **dead schema**: a repo-wide grep across `apps/chrono-api/src` for
`memberCode` outside migrations/schema/DTO-type-declarations finds **zero** call sites
that ever write a value into it — no generator, no admin-entry field, nothing. It is
exactly the kind of unused, speculative column `.ai/rules/ai-agent.md` and the RBAC
file's own "unused statement/table invites drift" principle warn against porting. This
plan **excludes it**. If a real physical member-card/loyalty-code need shows up later,
design it against the deferred `loyalty` module's actual requirements instead of
carrying forward a column oikos itself never used.

### Branch association — deliberately deferred (keeps `members` dependency-free)

oikos hard-requires picking a branch when applying (`applyForTenantMembership` throws
if the tenant has no active branches, and stores `applicationBranchId` in metadata).
Porting that as a real FK from `ChronoMemberProfiles` to `ChronoBranches` would make
`members` structurally depend on `branches` — contradicting the ratified, parallel-
plannable status both modules currently have (`.ai/handover/chrono-migration.md`). This
plan **defers branch association entirely**: a customer applies for tenant-level
membership only, with no branch selection step. This mirrors `branches`' own precedent
of deferring the `[branchCode]` "current branch" context switcher to whichever module
first has a real branch-scoped UI need — here, that's likely `stations`/`sessions`
(a station lives at one branch; a session happens at one station), not `members`. If the
developer wants branch-scoped membership restored, it is a one-column, backward-
compatible addition (`branchId` nullable FK) once `branches` has actually landed —
flagging now so it's a deliberate cut, not an oversight.

### Schema — `ChronoMemberProfiles`

New file `apps/chrono-api/src/modules/member/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoMemberProfile = pgTable(
  "ChronoMemberProfiles",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // One profile per tenantMember — enforced by the unique index below.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    phone: text("phone"),
    // Venue-membership approval workflow — orthogonal to tenantMember.status
    // ("active"/"suspended", the foundation's login-gate flag). A "pending"
    // profile can still sign in and see their own status; this field carries
    // no enforcement yet (see "Enforcement" note below).
    applicationStatus: text("applicationStatus").notNull().default("pending"), // "pending" | "approved" | "rejected"
    appliedAt: timestamp("appliedAt").notNull().defaultNow(),
    approvedAt: timestamp("approvedAt"),
    rejectedAt: timestamp("rejectedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_member_profile_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_member_profile_member_uq").on(t.memberId),
  ],
);
```

Deliberate differences from oikos's `TenantMember`:

- `phone` is a real column, not a `metadataJson` bag entry — matches `database.md`
  ("jsonb only for true extensibility") and the same call `branches` made promoting
  `email`/`operatingHours` out of oikos's `metadataJson`.
- No `metadataJson` blob at all — nothing in the fields ported needs one; add a real
  column instead if a genuine free-form need shows up later (`database.md`'s own
  guidance).
- `applicationStatus` has three states, not four — oikos's `SUSPENDED` state on
  `TenantMember` is redundant with agora's `tenantMember.status = "suspended"` (already
  enforced: a suspended `tenantMember` is blocked from signing in and has its sessions
  revoked, see `revokeMemberSessions`/`getMemberContext` in
  `packages/agora/src/member-auth/index.ts`). Reusing the existing suspend/reactivate
  actions on `customer` (already shipped, see "Critical scope finding") for that case
  avoids a second, competing suspension flag.
- No `joinedAt` — agora's `tenantMember.createdAt` already marks account creation;
  oikos's `joinedAt` tracked branch-visit join timing, which this pass has no branch
  concept for (see above).
- No `memberCode` (see above).

**Enforcement note**: nothing reads `applicationStatus` to block an action in this
pass — there is no `wallet`/`sessions` yet for a "pending" member to be blocked *from*.
It exists as a real, staff-manageable, audited field (matching oikos's actual workflow
shape) so `wallet`/`sessions` have something correct to gate on when they land, not as
an enforced control today. Calling this out explicitly so it isn't mistaken for a
security gate that doesn't yet exist.

### `APP_TENANT_TABLES`

Add `"ChronoMemberProfiles"` to the array in `apps/chrono-api/src/db/schema.ts`
(alongside `"ChronoBranches"`, added by the `branches` plan — whichever module lands
its migration first adds its own line; the other rebase's onto it), and re-export
`chronoMemberProfile` from the module into that file, mirroring `chronoBranch`'s
existing re-export exactly.

### Contracts — `apps/chrono-api/src/modules/member/contracts.ts`

```ts
import { z } from "zod";

export const memberApplicationStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const applyForMembershipSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

export const updateMemberProfileSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

export type MemberApplicationStatus = z.infer<typeof memberApplicationStatusSchema>;
export type ApplyForMembershipInput = z.infer<typeof applyForMembershipSchema>;
export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileSchema>;
```

### Routes — two Hono factories, two audiences

Chrono's `apps/chrono-api/src/routes/rpc.ts` (`TenantVars`) already fully covers
identity CRUD via the existing `/customers` routes — see "Critical scope finding". This
module adds only the venue-membership-workflow surface, on **two separate mount
points** because the two audiences authenticate differently (staff session vs. customer
portal session) — this is a genuine structural difference from `branches`, which only
ever needed the staff-side `TenantVars` factory.

**Staff-facing — `apps/chrono-api/src/modules/member/routes.ts`, `memberProfileRoutes()`**
(`TenantVars`, composed into `apps/chrono-api/src/routes/rpc.ts` via
`.route("/members", memberProfileRoutes())`):

- `GET /` — `requirePermission(c.var.tenant.permissions, { customer: ["read"] })`
  (reuses the existing action — this is a read over the same underlying entity, not a
  new capability). `zValidator("query", listQuerySchema(["appliedAt", "createdAt"]))`,
  `withTenant`, inner-joins `chronoMemberProfile` to `base.tenantMember` (name/email/
  status) so the list can render identity + venue fields in one row. Returns
  `{ items, meta }`.
- `PATCH /:memberId` — `requirePermission(c.var.tenant.permissions, { customer: ["update"] })`.
  `memberId` = the `tenantMember.id` (not the profile's own `id` — matches oikos's own
  `:id` = user/tenantMember convention in `customers/routes.ts`, and lets the client
  reuse the id it already has from `/rpc/customers`). Validates
  `updateMemberProfileSchema` (`phone` only, today). 404 if no profile row exists for
  that `memberId` in this tenant. `recordStaffAudit`.
- `POST /:memberId/approve` — `requirePermission(c.var.tenant.permissions, { customer: ["approve"] })`
  (**new action** — see "Permission vocabulary" below). Sets
  `applicationStatus: "approved"`, `approvedAt: now()`. 404 if not found/wrong tenant.
  `recordStaffAudit`.
- `POST /:memberId/reject` — `requirePermission(c.var.tenant.permissions, { customer: ["reject"] })`
  (**new action**). Sets `applicationStatus: "rejected"`, `rejectedAt: now()`. 404 if
  not found/wrong tenant. `recordStaffAudit`.

**Customer-facing — `apps/chrono-api/src/modules/member/portal-routes.ts`,
`memberPortalRoutes()`** (`MemberVars`, gated by `agora/member-auth`'s
`memberMiddleware()` — **not** `tenantMiddleware()`/`requirePermission`, since the
caller is a customer, not staff; mounted directly on the Hono app, mirroring how
`/portal/auth` is mounted, via `.route("/portal/members", memberPortalRoutes())` in
`apps/chrono-api/src/app.ts`):

- `GET /me` — returns the caller's own `ChronoMemberProfiles` row (or `{ profile: null }`
  if they haven't applied yet — not a 404; "hasn't applied" is a normal state, not an
  error).
- `POST /apply` — idempotent: if a profile already exists for `c.var.member.memberId`,
  returns it unchanged (no re-insert, no duplicate audit entry — mirrors oikos's own
  idempotent-apply behavior). Otherwise inserts a new row (`applicationStatus:
  "pending"`), `recordStaffAudit`-equivalent is **not** used here (that helper is
  staff-audit-shaped, keyed off a staff actor; this is a customer-initiated action —
  use a plain, unaudited insert for this pass, matching how the foundation's own
  `POST /portal/auth/sign-up` doesn't call `recordStaffAudit` either. Revisit if
  customer-initiated actions get their own audit trail later).

### Permission vocabulary

**Open Question 1 (resolve before Phase 3):** should a newly self-service-signed-up
customer's `ChronoMemberProfiles` row start at `"pending"` (requires staff approval —
matches oikos's real default and the workflow's shape) or `"approved"` (matches
agora's foundation default of "signup = instant full access," and there's genuinely
nothing to enforce against a pending customer yet)? This plan defaults **self-service
apply → `"pending"`**, **staff-created customer (existing `POST /rpc/customers`) →
`"approved"`** (an admin creating the account *is* the approval act, mirroring oikos's
`customerService`/`applyForTenantMembership` default-`APPROVED` path for staff-created
accounts). If the developer prefers matching the foundation's existing "signup = active
now" precedent throughout, `POST /apply` can default to `"approved"` instead — a
one-line change with no other plan impact, flagging now so it's deliberate.

**Open Question 2:** this plan extends the **existing** `customer` resource with two
new actions (`approve`, `reject`) rather than minting a new `chronoMember`/`member`
resource, unlike `branches`, which added a wholly new `branch` resource. Reasoning:
`ChronoMemberProfiles` is a 1:1 extension of `tenantMember`, governed by the same
`customer` resource that already reads/updates/suspends/reactivates that exact entity —
a second resource would duplicate `customer:read`/`customer:update` for the same rows
under a different name, which is the vocabulary-drift `rbac.md` warns against, not the
kind of genuinely new collection `branch` is. If the developer disagrees and wants
venue-membership actions on a separate resource (e.g. to grant "can approve members"
without granting "can suspend/delete customer accounts"), that's a legitimate,
different trust boundary — flagging so it's a deliberate call, not a default nobody
noticed. This plan proceeds with extending `customer`:

```ts
// packages/agora/src/auth/permissions.ts
export const PERMISSION_STATEMENTS = {
  ...
  customer: [
    "read",
    "create",
    "update",
    "suspend",
    "reactivate",
    "export",
    "delete",
    "approve", // new
    "reject",  // new
  ],
  ...
} as const;
```

- `staffRole` — **not touched** (staff already holds none of `customer`'s actions;
  approve/reject stay admin+, consistent with every other `customer` action).
- `adminRole` — add `"approve", "reject"` to its existing `customer: [...]` array
  (already present, holding every action except nothing is currently excluded from
  admin for `customer` — confirm the exact current array in
  `packages/agora/src/auth/permissions.ts` before editing; it should already list
  `read/create/update/suspend/reactivate/export/delete` verbatim).
- `ownerRole` — inherits automatically (spreads all of `PERMISSION_STATEMENTS`).

### Audit action naming

`recordStaffAudit` actions in this codebase already use `member.*` for **two** other,
unrelated things in the same file (`apps/chrono-api/src/routes/rpc.ts`, unchanged):
Better Auth staff-membership actions (`member.ownership_transferred`) **and** the
existing customer DSAR actions (`member.exported`, `member.deleted` — despite living
under the `/customers` route path). Reusing `member.*` a third time for
`ChronoMemberProfiles` events would make audit-log entries genuinely ambiguous between
three different entities. This plan uses the unambiguous prefix
**`chronoMemberProfile.*`** (`chronoMemberProfile.applied`, `.approved`, `.rejected`,
`.updated`) — flagging the collision explicitly since it's a real, code-confirmed
naming clash, not a hypothetical one.

### Web UI

- **Staff — `apps/chrono-web/src/app/dashboard/members/page.tsx` (new)**: mirrors
  `apps/chrono-web/src/app/dashboard/settings/customers/page.tsx`'s structure
  (`useListQuery()`, `DataTable`/`DataTableGrid`/`DataTableToolbar`/`DataTablePagination`
  from `agora/ui`) but calls the new `api.rpc.members.$get` /
  `api.rpc.members[":memberId"].approve.$post` / `.reject.$post` /
  `.$patch` endpoints and renders phone + `applicationStatus` (a `Badge`, matching the
  existing customers page's status-badge convention) + Approve/Reject buttons (visible
  only when `applicationStatus === "pending"`). This is a **separate page** from
  `/dashboard/settings/customers`, not a rewrite of it — that page keeps owning
  identity-level actions (suspend/export/delete); this one owns venue-membership
  review. Cross-link the two pages so staff can jump from a member row to the account
  page for identity actions.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Members` entry to `BASE_NAV`
  (a `Users`-style `lucide-react` icon) and `"/dashboard/members": "Members"` to
  `TITLES`, mirroring the `Projects`/`Branches` entries.
- **Customer — extend `apps/chrono-web/src/app/portal/page.tsx` (existing placeholder,
  not new)**: add a "Membership" `Card` beside the existing "Your account" card —
  shows `applicationStatus` if a profile exists, or an "Apply for membership" `Button`
  (calling `POST /portal/members/apply`) if it doesn't (`GET /portal/members/me` on
  load). Uses `useMemberSession()` from `@/lib/member-client` (already used by the
  existing placeholder) for the member identity; a new small client helper
  (`apps/chrono-web/src/lib/member-application.ts`, naming intentionally mirrors
  oikos's own file) wraps the two new `/portal/members/*` calls.

### Out of Scope (this plan)

- Branch association / branch-scoped applications (see "Branch association" above) —
  deferred to `stations`/`sessions`.
- `memberCode` (see "memberCode" above) — dead schema in oikos itself, not ported.
- Transactional emails at apply/approve/reject (oikos sends one per transition via
  Resend) — trivial follow-up using `agora/server`'s existing
  `renderBrandedEmail`/`sendTransactionalEmail`, not required to ship the workflow.
- `UserTenantHistory`-equivalent branch-visit logging (oikos's `customers` module
  `/join`/`/history` routes) — this is real venue-check-in telemetry tied to a
  station/device visit, not membership identity; belongs with `stations`/`sessions` if
  ported at all, not this plan.
- Wallet balance / active session / active station columns in the staff member list
  (oikos's `customers` list joins `Wallet`/`DeviceSession`/`Station`) — those modules
  don't exist yet; add the columns when `wallet`/`sessions` land.
- The `/rpc-admin` platform-admin cross-tenant view — no `PLATFORM_PERMISSION_STATEMENTS`
  resource exists for this today, same reasoning as `branches`.
- Any changes to the existing `/rpc/customers` routes, `agora/member-auth`, or
  `/dashboard/settings/customers` — reused as-is (see "Critical scope finding").
- `stations`/`sessions`/`wallet` code — separate, dependent plans.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List (staff) | `GET /rpc/members` | `customer:read` | paginated, joined with identity |
| Update phone (staff) | `PATCH /rpc/members/:memberId` | `customer:update` | 404 if no profile / wrong tenant |
| Approve (staff) | `POST /rpc/members/:memberId/approve` | `customer:approve` (new) | 404 if no profile / wrong tenant |
| Reject (staff) | `POST /rpc/members/:memberId/reject` | `customer:reject` (new) | 404 if no profile / wrong tenant |
| View own (customer) | `GET /portal/members/me` | member session (portal) | `{ profile: null }` if none yet |
| Apply (customer) | `POST /portal/members/apply` | member session (portal) | idempotent — no duplicate row |
| Delete | — | — | not built this pass — deleting the `tenantMember` (existing `DELETE /rpc/customers/:id`) cascades the profile row via FK; no standalone profile delete |

Feedback: `toast.success`/`toast.error` on the staff page (per `.ai/rules/ui.md`),
matching `/dashboard/settings/customers`'s inline-message convention. The portal page
shows the apply button's result inline in the Membership card (no toast — matches the
placeholder page's existing plain-`Card` style, no `Toaster` currently wired into
`/portal`).

Audit linkage: `recordStaffAudit` on staff update/approve/reject
(`chronoMemberProfile.updated/.approved/.rejected`); the customer's own apply action is
unaudited in this pass (see Routes section).

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/member/schema.ts` (new) — `chronoMemberProfile` table
  (see Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export `chronoMemberProfile`, add
  `"ChronoMemberProfiles"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/member/` and write `schema.ts` exactly as
   specified in Pass 2 (table name `"ChronoMemberProfiles"`, both indexes, FK to
   `base.tenantMember.id`).
2. In `apps/chrono-api/src/db/schema.ts`, add
   `import { chronoMemberProfile } from "../modules/member/schema";` +
   `export { chronoMemberProfile };`, and append `"ChronoMemberProfiles"` to the
   `APP_TENANT_TABLES` tuple (alongside whatever `branches` has already added — check
   the file's current state first; don't clobber a concurrently-landed entry).
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_member_profiles`
   (never `db:push`). Review the generated SQL: expect a single
   `CREATE TABLE "ChronoMemberProfiles"` plus its two indexes and its FK to
   `"TenantMembers"`, no destructive statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- `ChronoMemberProfiles` exists with `FORCE ROW LEVEL SECURITY` on.
- `"ChronoMemberProfiles"` is present in `APP_TENANT_TABLES`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/member/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/member/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `memberApplicationStatusSchema`, `applyForMembershipSchema`,
   `updateMemberProfileSchema` and their `z.infer` types exactly as specified in
   Pass 2.
2. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- `ApplyForMembershipInput`/`UpdateMemberProfileInput`/`MemberApplicationStatus` types
  compile and are importable from `../modules/member/contracts` inside
  `apps/chrono-api`.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/member/contracts.ts`.

---

## Phase 3 — Routes + permission gates

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `"approve"`, `"reject"` to
  `PERMISSION_STATEMENTS.customer` and to `adminRole`'s existing `customer: [...]`
  array (resolve Open Questions 1 & 2 first — see Pass 2).
- `apps/chrono-api/src/modules/member/routes.ts` (new) — `memberProfileRoutes()`
  factory (`TenantVars`).
- `apps/chrono-api/src/modules/member/portal-routes.ts` (new) — `memberPortalRoutes()`
  factory (`MemberVars`, `memberMiddleware()`).
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/members", memberProfileRoutes())`.
- `apps/chrono-api/src/app.ts` — `.route("/portal/members", memberPortalRoutes())`,
  mirroring the existing `.route("/portal/auth", createMemberAuthRoutes())` line.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `customer:approve` /
  `customer:reject` gate cases (staff denied, admin/owner allowed), mirroring the
  file's existing `customer` cases.

**Step-by-step tasks**

1. Add `"approve"`, `"reject"` to `PERMISSION_STATEMENTS.customer` and to
   `adminRole`'s `customer` array in `packages/agora/src/auth/permissions.ts` (owner
   inherits automatically via `...PERMISSION_STATEMENTS`; `staffRole` gets nothing).
2. Write `apps/chrono-api/src/modules/member/routes.ts`: `GET /` (ungated beyond
   `customer:read`, paginated via `listQuerySchema(["appliedAt", "createdAt"])`,
   joins `chronoMemberProfile` → `base.tenantMember`), `PATCH /:memberId`
   (`customer:update`), `POST /:memberId/approve` (`customer:approve`),
   `POST /:memberId/reject` (`customer:reject`) — all `withTenant`-scoped, 404 on
   missing/cross-tenant, `recordStaffAudit` with the `chronoMemberProfile.*` action
   names from Pass 2. Follow the exact structure of the `/customers` block in
   `apps/chrono-api/src/routes/rpc.ts` (import style, `HttpError`, pagination meta
   shape) without touching that file's existing routes.
3. Write `apps/chrono-api/src/modules/member/portal-routes.ts`: `GET /me` (reads
   `c.var.member.memberId` from `memberMiddleware()`, returns `{ profile }` or
   `{ profile: null }`), `POST /apply` (idempotent insert, `applicationStatus:
   "pending"`, validates `applyForMembershipSchema`).
4. Compose into `apps/chrono-api/src/routes/rpc.ts` via
   `.route("/members", memberProfileRoutes())`, and into
   `apps/chrono-api/src/app.ts` via
   `.route("/portal/members", memberPortalRoutes())` (import `memberMiddleware` from
   `agora/member-auth`, matching the existing `/portal/auth` mount's style).
5. Add `customer:approve` / `customer:reject` cases to
   `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { customer: ["approve"] }) === false`,
   `hasPermission("admin", { customer: ["approve"] }) === true`,
   `hasPermission("owner", { customer: ["approve"] }) === true` (and the same for
   `"reject"`), alongside the file's existing `customer` cases.

**Acceptance criteria**

- `GET /rpc/members` returns `{ items, meta }` for admin/owner (per `customer:read`,
  already admin+ only — staff gets 403, same as every existing `customer` action).
- `POST /rpc/members/:memberId/approve` as staff → 403; as admin/owner → 200 with
  `applicationStatus: "approved"`.
- `POST /portal/members/apply` as a signed-in customer creates a `pending` profile;
  calling it again returns the same row, not a duplicate.
- `PATCH/approve/reject` on another tenant's `memberId` → 404.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new cases
  included.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out of scope:** UI, e2e browser spec (Phase 5).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (both
route files import `requirePermission`/reference the resource, so the vocabulary must
exist before either typechecks).

---

## Phase 4 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/members/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `apps/chrono-web/src/app/portal/page.tsx` — extend the existing placeholder with a
  Membership card.
- `apps/chrono-web/src/lib/member-application.ts` (new) — thin client wrapper for
  `GET/POST /portal/members/*`.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected).

**Step-by-step tasks**

1. Build `dashboard/members/page.tsx` mirroring
   `apps/chrono-web/src/app/dashboard/settings/customers/page.tsx`: `useListQuery()`,
   `api.rpc.members.$get` / `.$patch` / `.approve.$post` / `.reject.$post`,
   `DataTable`/`DataTableGrid` + `DataTableToolbar` + `DataTablePagination`, a
   status `Badge` (pending/approved/rejected), Approve/Reject buttons gated on
   `applicationStatus === "pending"`.
2. Add `{ type: "item", name: "Members", href: "/members", icon: <Users> }` to
   `BASE_NAV`, and `"/dashboard/members": "Members"` to `TITLES`, in
   `apps/chrono-web/src/app/dashboard/layout.tsx`.
3. Write `apps/chrono-web/src/lib/member-application.ts`: `getMyMembership()` (GET
   `/portal/members/me`), `applyForMembership(phone?)` (POST `/portal/members/apply`).
4. Extend `apps/chrono-web/src/app/portal/page.tsx`: add a "Membership" `Card` next to
   the existing "Your account" card, using the two new lib functions — shows status if
   a profile exists, an "Apply for membership" button if not.
5. Wire `toast.success`/`toast.error` on the staff page's mutations, matching
   `/dashboard/settings/customers`'s inline-message convention (no `<FormError>`).

**Acceptance criteria**

- `/dashboard/members` renders the list; search/sort/paginate/view-toggle update the
  URL.
- Approve/Reject buttons work and the list refreshes; a staff-role session gets a
  toast error attempting either (server 403 surfaces client-side).
- `/portal` shows the apply button when the signed-in customer has no profile yet, and
  the current status once they've applied.
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 5), branch-scoped application UI, wallet/session
columns.

**Execution start point:** create `apps/chrono-web/src/app/dashboard/members/page.tsx`.

---

## Phase 5 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/members/members.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring
   `apps/chrono-web/e2e/tests/data-listing/projects-listing.spec.ts`'s structure and
   `signUp()` helper, covering three cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant (staff), sign up a customer via `/portal/sign-up`,
     apply for membership from `/portal`, confirm `applicationStatus: "pending"` shows;
     as staff, navigate to `/dashboard/members`, approve the pending row, confirm the
     portal page reflects `"approved"` on reload.
   - **Role gate**: owner invites a staff teammate; staff can view `/dashboard/members`
     but attempting Approve/Reject surfaces a 403-driven toast and the status is
     unchanged.
   - **Tenant isolation**: tenant A's customer applies; tenant B's `/dashboard/members`
     list never shows that row (search included).
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for slugs/emails/names,
   per the rule's explicit requirement.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config, per `.ai/rules/rbac.md`'s "Testing" section).
- No `.env` present in `apps/chrono-api` while running (drives the real dev server).

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/members/members.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage (no platform-admin routes exist for
members in this pass).

**Execution start point:** create
`apps/chrono-web/e2e/tests/members/members.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/members/` to
`.ai/plans/chrono/archive/members/` once all five phases are verified and committed
separately. If `apps/chrono-api/src/modules/README.md` still exists at that point (its
own instruction says delete it once the first module lands — check whether a
concurrently-landed `branches` already removed it before deleting it again).
