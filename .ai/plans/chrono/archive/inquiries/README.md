# Chrono — `inquiries` module

**No hard schema dependency.** Uses `tenantMember` (nullable link) for an identified
customer and a freeform name/email/phone snapshot for an anonymous one — same nullable-
identity pattern `reservations`/`pos` already established for walk-in customers. No
dependency on `devices`/`sessions`/`stations`.

**Distinct from `packages/agora`'s platform-wide `supportTicket` system** — confirmed by
reading `packages/agora/src/auth/permissions.ts` (`platformSecurity`, `supportTicket`
resources) and `.ai/rules/rbac.md`'s `supportTicket` section: that system is Agora
**staff/platform-admin** tooling at `/admin/support` (`/rpc-admin/support-tickets/*`),
where Agora's own support team handles tickets **from tenants** (a tenant complaining to
Agora). This module is the opposite direction and a different actor entirely: **a
tenant's own customers** (gamers at a Chrono venue) submitting inquiries **to that
tenant's own staff** — a per-tenant, RLS-scoped table, visible only to that tenant's
dashboard, never surfaced in the platform admin console. The two systems share a shape
(ticket lifecycle, staff assignment, messages) but not a table, a permission resource,
or an audience — this plan does not touch `packages/agora`'s `supportTicket` at all.

---

## What this is

A per-tenant "Contact Us" / inquiry inbox: a venue's customers ask a question, report a
problem, or request something (a station issue, a billing question, a general inquiry)
either through a logged-in portal form or — the decision point this plan resolves
explicitly — an anonymous public form. Staff triage, assign, respond, and close out each
inquiry from the dashboard.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Customer (`tenantMember`, logged into the portal)** — submits an inquiry from
  `/portal/inquiries`, sees their own inquiry history and staff replies.
- **Anonymous visitor (no `tenantMember` session)** — **can also submit**, via a public
  contact form on the tenant's own public-facing page (see Decision 1 below) — this is
  a deliberate, justified choice, not a default.
- **Staff / Admin / Owner** — see the tenant's inbox (all inquiries, filterable by
  status/category), assign an inquiry to themselves or a teammate, reply, change
  status, close.
- **Platform admin** — no involvement (see the distinction from `supportTicket` above).

**Workflow:** A customer at Branch 2 wants to ask about a lost item. Logged into the
portal, they go to **Inquiries → New**, pick a category ("Lost & Found"), write a
message, submit — it lands as `new`, unassigned. Staff sees it in **Dashboard →
Inquiries**, clicks **Assign to me**, writes a reply (visible to the customer in their
portal thread), and once resolved, clicks **Close**. A logged-out visitor on the venue's
public page can also submit a general inquiry (e.g. "Do you have PS5s at your Makati
branch?") without an account — this creates the same row shape with `tenantMemberId:
null` and a captured name/email, and importantly **does not create a `tenantMember`
account** (see Decision 2 — no silent identity creation, matching this plan's own
Divergence from oikos's platform-Inquiry model, which has no concept of tenant identity
at all).

**Failure cases:**

- A `tenantMember` submitting from the portal with no message → 400 (Zod).
- An anonymous submission with no valid email → 400.
- A tenant member with no `inquiry:read`/`:manage` grant attempting to view/act in the
  dashboard → 403.
- Assigning an inquiry already closed → 409 (must reopen first — see status
  vocabulary).
- Replying to a closed inquiry → 409, unless the reply itself reopens it (**Open
  Question 1**: does a customer reply to a closed inquiry auto-reopen it, or must staff
  explicitly reopen? Defaults to **auto-reopen on a new customer message**, matching
  how most helpdesk tools behave and avoiding a customer's message getting silently
  dropped into a closed thread).
- A customer viewing another customer's inquiry by guessing an id → 404, scoped by
  `tenantMemberId = current member` in addition to tenant RLS (RLS alone isn't enough
  here — it scopes by tenant, not by which customer within the tenant).
- **Tenant-isolation leak scenario**: tenant A's inquiry must never be visible to tenant
  B's staff dashboard (RLS) — and separately, an anonymous public submission must
  resolve to the *correct* tenant from the host it was submitted on, never a
  client-supplied `tenantId` (same host-resolution discipline as `qr`'s public surface).
- Rate limiting on the anonymous public endpoint (**Open Question 2** /
  Divergence 3below) — an unauthenticated form is a spam target.
- Stale screen: two staff replying/assigning at once — last write wins on assignment
  (no lock needed, matches `reservations`' framing that this is routine ops work, not
  a money/inventory race); a reply is always additive (a new message row), never an
  overwrite, so no race is possible there by construction.

**Audit / notifications:** every assign/reply/status-change writes `recordStaffAudit`
(`chronoInquiry.assigned` / `.replied` / `.statusChanged`). A new inquiry (customer- or
anonymous-submitted) triggers a `tenantNotification` bell entry for staff with
`inquiry:read` (**Open Question 3**: to which staff — all of them, or a configurable
recipient list? Defaults to **all staff holding `inquiry:manage`**, matching the
simplest "everyone who could act on it gets notified" rule with no per-tenant routing
config to build in this pass). A customer reply/status-change on their own inquiry could
similarly notify the customer via portal-side `tenantNotification` — **Open Question 4**:
is the customer-facing notification bell already wired into the portal shell, or does
this plan need to extend it? Check `apps/chrono-web/src/app/portal/` before Phase 4; if
absent, email-only feedback (a toast on the page they're viewing) is the fallback for
this pass, not a new notification subsystem.

---

## Pass 2 — Technical Planning

### Decision 1 — anonymous inquiries are allowed, gated by category

Two options: require `tenantMember` login for every inquiry, or allow a fully anonymous
path. This plan allows **both**, split by whether the inquiry is inherently tied to an
existing account or not:

- **General/pre-sales inquiries** ("do you have X," "what are your hours") are
  legitimately asked by someone who has never signed up and shouldn't have to, to ask a
  question — gating this behind a login would just suppress inquiries, not improve
  quality.
- **Account-specific inquiries** (billing, a specific session dispute, a wallet
  balance question) inherently require knowing *which* customer is asking — these
  categories are only submittable from the logged-in portal form, never the public one.

The category taxonomy therefore drives which submission surface accepts it — public
categories: `general`, `lost_and_found`, `feedback`; portal-only categories: `billing`,
`session_issue`, `account`. See Contracts for the exact Zod split. This is a **deliberate
correction of oikos's actual model** — see Divergence 1 below, oikos's `Inquiry` isn't
even the same feature (it's a platform-level marketing lead-capture table with no
category split at all).

### Divergences from oikos prior art

Read directly from `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/modules/inquiries/{dto.ts,service.ts,routes.ts,public-routes.ts,contact-route.ts}`.

1. **oikos's "Inquiry" is not the same feature — it's a platform-level demo-request /
   marketing-lead table, unrelated to a tenant's own customers.** Its schema has no
   `tenantId` at all (`inquiryService.create` never scopes by tenant), its routes are
   gated `requireRole(['SUPER_ADMIN'])` (Agora's platform-admin equivalent, not tenant
   staff), and its categories (`DEMO`, `GENERAL`) are marketing-site categories ("book a
   demo of the SaaS itself"), not venue-customer-support categories. **This plan does
   not reuse any of oikos's `Inquiry` shape** beyond the general "public form → staff
   triage → status lifecycle" pattern shape — the actual schema, actor model, and
   permission gate are all newly designed here for the correct (per-tenant,
   tenant-customer-facing) feature. This is the single most important divergence: an
   agent tempted to "port `Inquiry`" would build the wrong feature entirely.
2. **No anonymous-vs-identified split, no category-gated submission surface** — oikos's
   single `createInquirySchema` has no concept of a logged-in submitter at all (there is
   no tenant customer pool in its model), so there's nothing to diverge from
   mechanically, but the *design gap* it leaves (should some categories require
   identity?) is one this plan closes with Decision 1 above rather than picking oikos's
   implicit answer (everything is anonymous) or the opposite extreme (everything
   requires login).
3. **reCAPTCHA-gated but otherwise unrate-limited public endpoint.** oikos's
   `public-routes.ts` and `contact-route.ts` both call `verifyRecaptcha` but have no
   per-IP rate limiter at all (unlike `qr`'s `/validate`, which at least has
   `qrLimiter`) — a slow-and-low spam campaign that stays under the recaptcha score
   threshold has no secondary throttle. This plan adds a per-IP rate limit on the
   public submission route in addition to whatever CAPTCHA/spam mitigation is chosen
   (**Open Question 2**: does agora have an existing CAPTCHA provider integration to
   reuse, or does this pass ship rate-limiting only and defer CAPTCHA? Check
   `packages/agora/src/server` / `.ai/rules/providers.md`'s provider table before
   assuming one exists — none is listed there today, so this plan defaults to
   **rate-limiting only in this pass**, CAPTCHA as a follow-up once a provider
   abstraction exists, rather than hand-rolling a bespoke reCAPTCHA integration that
   doesn't fit the existing provider-category pattern).
4. **Two near-duplicate public entry points** (`public-routes.ts`'s `POST /` and
   `contact-route.ts`'s `POST /`) that both insert into the same table via slightly
   different field-mapping and validation, one of which does an awkward post-insert
   `UPDATE ... SET metadata` round-trip to bolt on fields the first insert didn't
   capture. This plan has **exactly one public submission contract** (Contracts below)
   covering every public-category field up front — no second insert-then-patch step.
5. **`updateStatus` hand-writes its own before/after audit diff via a bespoke
   `auditLogService.create` call with `tenantId: undefined` (literally commented
   "System-wide inquiry")** — a direct symptom of divergence 1 (there's no real tenant
   to scope to). This plan uses the standard `recordStaffAudit` helper, tenant-scoped
   like every other Chrono module, with no special-cased "system-wide" branch.
6. **No message-thread table at all** — oikec's model has a single `message` field
   captured once at creation with no reply/thread concept; staff can only change
   `status`, never actually respond to the customer inside the product. This plan adds
   a proper `ChronoInquiryMessages` child table (see Schema) specifically because
   "staff replies to a customer inquiry" is Pass 1's core workflow and has zero
   precedent to build from in oikos.

### Pattern to copy

- `apps/chrono-api/src/modules/reservation/schema.ts` — nullable `memberId` +
  freeform-snapshot-fields precedent, applied here to `tenantMemberId` +
  `submitterName`/`submitterEmail`.
- `apps/chrono-api/src/modules/security-alert/schema.ts` (this same plan batch) — the
  `status` state-machine + `resolvedByUserId`/`resolvedAt` shape, applied here to
  `assignedToUserId`/`closedAt`.
- `apps/chrono-api/src/db/schema.ts`'s `tenantNotification` table — reused directly for
  the staff-notify-on-new-inquiry behavior, no new notification table.

### Schema

New file `apps/chrono-api/src/modules/inquiry/schema.ts`:

```ts
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoInquiry = pgTable(
  "ChronoInquiries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Nullable — an anonymous public submission. See Decision 1.
    tenantMemberId: text("tenantMemberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // Captured for both anonymous AND identified submitters (denormalized
    // snapshot even when tenantMemberId is set, so a later profile-name
    // change never rewrites historical inquiry rows — same reasoning as
    // ChronoReservations.customerName / TenantNotifications.actorName).
    submitterName: text("submitterName").notNull(),
    submitterEmail: text("submitterEmail").notNull(),
    submitterPhone: text("submitterPhone"),
    // See Decision 1's category split; Zod enforces which categories are
    // reachable from the public (unauthenticated) endpoint.
    category: text("category").notNull(),
    subject: text("subject").notNull(),
    // "new" | "assigned" | "in_progress" | "resolved" | "closed"
    // "resolved" vs "closed": resolved = staff believes it's handled but
    // leaves it open a beat for the customer to confirm/reply; closed = done,
    // reopens automatically on a new customer message (Open Question 1).
    status: text("status").notNull().default("new"),
    assignedToUserId: text("assignedToUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_inquiry_tenant_idx").on(t.tenantId),
    index("chrono_inquiry_tenant_member_idx").on(t.tenantMemberId),
    index("chrono_inquiry_status_idx").on(t.status),
    index("chrono_inquiry_assigned_idx").on(t.assignedToUserId),
    index("chrono_inquiry_created_idx").on(t.createdAt),
  ],
);

export const chronoInquiryMessage = pgTable(
  "ChronoInquiryMessages",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    inquiryId: text("inquiryId")
      .notNull()
      .references(() => chronoInquiry.id, { onDelete: "cascade" }),
    // "customer" | "staff" — who authored this message.
    authorType: text("authorType").notNull(),
    // Set only when authorType === "staff"; restrict, matching every other
    // "who did this" FK in the codebase.
    authorUserId: text("authorUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    // Set only when authorType === "customer" AND the submitter was
    // identified (tenantMemberId on the parent was non-null).
    authorMemberId: text("authorMemberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_inquiry_message_tenant_idx").on(t.tenantId),
    index("chrono_inquiry_message_inquiry_idx").on(t.inquiryId),
    index("chrono_inquiry_message_created_idx").on(t.createdAt),
  ],
);

export type NewChronoInquiry = typeof chronoInquiry.$inferInsert;
export type ChronoInquiryRow = typeof chronoInquiry.$inferSelect;
export type NewChronoInquiryMessage = typeof chronoInquiryMessage.$inferInsert;
export type ChronoInquiryMessageRow = typeof chronoInquiryMessage.$inferSelect;
```

The original submission `message`/`subject` is stored as the **first**
`ChronoInquiryMessages` row (`authorType: "customer"`), not a duplicated column on
`chronoInquiry` itself — avoids the "where's the real message, the parent row or the
thread" ambiguity oikos's single-`message`-field design didn't have to worry about but
this richer model would if it kept both.

### `APP_TENANT_TABLES`

Add `"ChronoInquiries"` and `"ChronoInquiryMessages"`.

### Permission vocabulary — `inquiry`

```ts
inquiry: ["read", "manage"],
```

`manage` covers assign/reply/status-change; `read` covers list/detail. Both staff and
admin get both (**Open Question 5**: same "no staff/admin split for routine ops" default
as `reservation`/`securityAlert` — flagged for consistency, not re-litigated per
module).

### Contracts — `apps/chrono-api/src/modules/inquiry/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

// Public (unauthenticated) categories only — see Decision 1.
export const publicInquiryCategorySchema = z.enum(["general", "lost_and_found", "feedback"]);
// Portal (authenticated tenantMember) categories — superset.
export const portalInquiryCategorySchema = z.enum([
  "general",
  "lost_and_found",
  "feedback",
  "billing",
  "session_issue",
  "account",
]);

export const submitPublicInquirySchema = z.object({
  submitterName: z.string().min(1).max(255),
  submitterEmail: z.string().email(),
  submitterPhone: z.string().max(50).optional(),
  category: publicInquiryCategorySchema,
  subject: z.string().min(1).max(255),
  message: z.string().min(1).max(4000),
});

export const submitPortalInquirySchema = z.object({
  category: portalInquiryCategorySchema,
  subject: z.string().min(1).max(255),
  message: z.string().min(1).max(4000),
});

export const replyToInquirySchema = z.object({
  body: z.string().min(1).max(4000),
});

export const updateInquiryStatusSchema = z.object({
  status: z.enum(["assigned", "in_progress", "resolved", "closed"]),
});

export const inquiryListQuerySchema = listQuerySchema(["createdAt", "updatedAt"]).extend({
  status: z.enum(["new", "assigned", "in_progress", "resolved", "closed"]).optional(),
  category: portalInquiryCategorySchema.optional(),
  assignedToUserId: z.string().optional(),
});
```

### Routes

**Staff-facing** (`/rpc/inquiries`, `tenantMiddleware()`):
- `GET /` — list, gate `inquiry:["read"]`.
- `GET /:id` — detail + message thread, gate `inquiry:["read"]`.
- `POST /:id/assign` — sets `assignedToUserId` to caller (or a specified staff user id,
  validated to be a member of the same tenant), gate `inquiry:["manage"]`.
- `POST /:id/reply` — inserts a `ChronoInquiryMessages` row (`authorType: "staff"`),
  auto-transitions `status` from `new`/`assigned` → `in_progress` if not already past
  it, gate `inquiry:["manage"]`.
- `PATCH /:id/status` — validated transitions only (no `resolved`/`closed` →
  `new` skip-back; use `assign`/`reply` to move forward, this endpoint only for
  resolve/close/reopen), gate `inquiry:["manage"]`.

**Portal-facing** (`/rpc/portal/inquiries` or wherever the existing member-portal
routes mount — check `apps/chrono-api/src/modules/member/portal-routes.ts` for the
established mount convention before choosing), authenticated via the foundation's
`tenantMember` session, NOT staff `tenantMiddleware()`:
- `POST /` — `submitPortalInquirySchema`, creates the inquiry + its first message,
  `tenantMemberId` from the resolved member session (never client input).
- `GET /` — the calling member's own inquiries only (`tenantMemberId = self`, in
  addition to tenant scoping).
- `GET /:id` — 404 if not owned by the calling member.
- `POST /:id/reply` — adds a `ChronoInquiryMessages` row (`authorType: "customer"`),
  auto-reopens if `closed` (Open Question 1's default).

**Public** (outside `/rpc`, outside any session requirement, mounted in
`apps/chrono-api/src/app.ts` next to `qr`'s public routes):
- `POST /public/inquiries` — `submitPublicInquirySchema`, rate-limited per-IP
  (Divergence 3), tenant resolved from the request host (same discipline as `qr`'s
  public resolve endpoint — never a client-supplied `tenantId`).

---

## Phase 1 — DB Schema + RLS

**Files to Update**
- New: `apps/chrono-api/src/modules/inquiry/schema.ts`
- Update: `apps/chrono-api/src/db/schema.ts`

**Step-by-Step Tasks**
1. Write both tables per Schema above.
2. Wire into `db/schema.ts`, add both names to `APP_TENANT_TABLES`.
3. `pnpm db:generate --name add_chrono_inquiries`, review SQL.
4. `pnpm db:migrate`.

**Acceptance Criteria**
- Both tables exist, RLS-forced, FKs correct (including the two nullable
  `tenantMemberId`/`assignedToUserId`/`authorUserId`/`authorMemberId` references).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Notification wiring (Phase 3/4).

**Execution Start Point**
- Read `apps/chrono-api/src/db/schema.ts` current state first.

---

## Phase 2 — Contracts + Permission Vocabulary

**Files to Update**
- New: `apps/chrono-api/src/modules/inquiry/contracts.ts`
- Update: `apps/chrono-api/src/auth/permissions.ts`

**Step-by-Step Tasks**
1. Write contracts per above.
2. Add `inquiry: ["read", "manage"]` to `CHRONO_PERMISSION_STATEMENTS`,
   `CHRONO_STAFF_GRANTS`, `CHRONO_ADMIN_GRANTS`.

**Acceptance Criteria**
- Compiles; resource appears in the permission vocabulary.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out-of-Scope**
- Routes (Phase 3).

**Execution Start Point**
- Read `apps/chrono-api/src/auth/permissions.ts` in full before editing.

---

## Phase 3 — Routes (staff + portal + public)

**Files to Update**
- New: `apps/chrono-api/src/modules/inquiry/routes.ts` (staff)
- New: `apps/chrono-api/src/modules/inquiry/portal-routes.ts` (portal, model after
  `apps/chrono-api/src/modules/member/portal-routes.ts`)
- New: `apps/chrono-api/src/modules/inquiry/public-routes.ts`
- Update: `apps/chrono-api/src/routes/rpc.ts`, `apps/chrono-api/src/app.ts`

**Step-by-Step Tasks**
1. Implement staff routes per Routes above — `requirePermission` first, `withTenant`
   for every query, `recordStaffAudit` on assign/reply/status-change.
2. Implement portal routes, scoping every read/write to the calling member's own
   `tenantMemberId` in addition to tenant RLS.
3. Implement the public route with per-IP rate limiting and host-based tenant
   resolution (reuse whatever helper `qr`'s public routes established, if that plan
   landed first — otherwise build the minimal host-resolution helper here and let `qr`
   reuse it, whichever lands first should factor it out for the other).
4. Wire the `tenantNotification` insert on new-inquiry creation (staff-facing bell).

**Acceptance Criteria**
- Full round trip: public submit → staff sees it in inbox + gets notified → assign →
  reply → customer sees reply in portal → resolve → close → customer reply reopens.
- Cross-tenant and cross-member isolation both verified manually (a member cannot see
  another member's inquiry; tenant B never sees tenant A's rows).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- A route/unit test for the status state machine (including the auto-reopen case).

**Out-of-Scope**
- CAPTCHA integration (Divergence 3, deferred).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/member/portal-routes.ts` first for the portal
  mount/auth convention.

---

## Phase 4 — Web UI (staff inbox + portal) + E2E

**Files to Update**
- New: `apps/chrono-web/src/app/dashboard/inquiries/page.tsx` (list) +
  `apps/chrono-web/src/app/dashboard/inquiries/[id]/page.tsx` (detail/thread view)
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add `{ type: "item", name:
  "Inquiries", href: "/inquiries", icon: <a MessageSquare-style lucide-react icon> }`
  to `BASE_NAV`, and `"/dashboard/inquiries": "Inquiries"` to `TITLES`.
- New: `apps/chrono-web/src/app/portal/inquiries/page.tsx` (+ new-inquiry form,
  thread view)
- New: a public contact form page (check whether `apps/chrono-web` has any existing
  public marketing page to attach this to before creating a new route — if none
  exists yet, a minimal `apps/chrono-web/src/app/contact/page.tsx` is in scope for
  this phase, styled minimally, not a full marketing page)
- New: `apps/chrono-web/e2e/tests/inquiries/inquiries.spec.ts`

**Step-by-Step Tasks**
1. Staff inbox: `DataTableToolbar`/`DataTable`/`DataTablePagination` stack, filters for
   status/category/assignee, `useListQuery()`.
2. Detail/thread view: message list + reply box (`Textarea` + `Button`) + status
   `Select` (`open`/`in_progress`/`resolved`/`closed`) + assignee `Select` (staff
   list) — `agora/ui` primitives only, no raw HTML chrome.
3. Portal: new-inquiry form (`Select` for `portalInquiryCategorySchema`, `Textarea`
   for the message body) + own inquiry list + thread view (read + reply only, no
   status/assign controls).
4. Public contact form: `Select` for `publicInquiryCategorySchema`, name/email/
   message `Input`/`Textarea` fields, no auth-gated fields shown.
5. E2E (one spec file, three `test.describe` blocks per `.ai/rules/e2e-testing.md`):
   happy path (anonymous public submit → staff assign/reply/resolve/close, status
   visible updating live), role gate (a session with `inquiry:read` but not
   `inquiry:manage` can see the inbox but assign/reply/status-change controls are
   hidden client-side and 403 server-side if forced), tenant + cross-member isolation
   (tenant B never sees tenant A's inquiries; `tenantMember` A's portal session
   cannot open `tenantMember` B's inquiry by direct id — 404).

**Acceptance Criteria**
- Staff inbox renders the list with working status/category/assignee filters;
  search/sort/paginate update the URL via `useListQuery()`.
- Staff detail view: replying appends to the thread, changing status/assignee
  persists and reflects immediately, all via `toast.success`/`toast.error`.
- Portal: a `tenantMember` can submit a new inquiry, see it in their own list, and
  reply to their own thread — never another member's.
- Public contact form: an anonymous visitor can submit without authentication and
  sees a toast/confirmation message, no thread access afterward (per the CRUD &
  Feedback Contract's Open Question 6 default).
- All three e2e cases (happy path, role gate, tenant+cross-member isolation) pass.
- No raw HTML chrome introduced in `apps/chrono-web`.

**Verification Commands**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/inquiries/inquiries.spec.ts`
  (with `pnpm dev` already running, per `.ai/rules/rbac.md`'s manual Playwright
  convention — no `.env` present in `apps/chrono-api` while running)

**Out-of-Scope**
- Customer-facing notification bell wiring if it doesn't already exist in the portal
  shell (Open Question 4) — falls back to in-page toast only.

**Execution Start Point**
- Check `apps/chrono-web/src/app/portal/` for an existing notification-bell component
  before building Phase 4 — reuse it if present, don't assume.

---

## CRUD & Feedback Contract

| Action | Who | Feedback |
|---|---|---|
| Create (portal) | authenticated `tenantMember` | toast success, redirect to thread |
| Create (public) | anonymous visitor | toast success, confirmation message (no thread access without an account — **Open Question 6**: should an anonymous submitter get a magic-link-style thread view? Defaults to **no** — they gave an email, staff replies by email out-of-band via the assigned staff member's own judgment, this plan does not build an anonymous-thread-lookup surface) |
| Read (staff inbox) | staff/admin/owner (`inquiry:read`) | table + filters |
| Read (portal) | the owning `tenantMember` only | own inquiries + thread |
| Update (assign/reply/status) | staff/admin/owner (`inquiry:manage`) | toast success, thread/status updates live |
| Delete | **not supported** — inquiries are closed, never deleted (support-history retention) |

No soft-delete needed. Every staff mutation is audit-linked via `recordStaffAudit`.

---

## Open Questions

1. Does a customer reply to a `closed` inquiry auto-reopen it? Defaults to **yes**.
2. CAPTCHA/anti-spam beyond per-IP rate limiting on the public endpoint? Defaults to
   **rate-limiting only this pass** (no CAPTCHA provider exists in `.ai/rules/providers.md`
   today).
3. Recipient scope for the new-inquiry staff notification — all `inquiry:manage`
   holders, or a configurable list? Defaults to **all holders**.
4. Does the portal shell already have a notification bell to hook into? Check before
   Phase 4; falls back to in-page toast if not.
5. Staff/admin split on `inquiry:manage`, or uniform like `reservation`? Defaults to
   **uniform**.
6. Anonymous-submitter thread lookup (magic link)? Defaults to **not built** — staff
   respond out-of-band by email for anonymous inquiries.
