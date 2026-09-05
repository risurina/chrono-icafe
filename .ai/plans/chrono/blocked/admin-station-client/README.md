# Chrono — `admin-station-client` module (BLOCKED — narrowed)

**2026-09-02 update — reconciled against the real `devices` plan, which is now fully
archived (`.ai/plans/chrono/archive/devices/`).** `devices` shipped schema, RLS,
permission-gated routes, device-auth middleware, web UI, and e2e — **all five phases**,
not just Phase 2 as this file originally reported. Re-reading this plan's own Phase 1/2
against the real landed code found they are **already fully satisfied by `devices`
itself**, not merely unblocked:

- Phase 1's ask ("permission resource, routes" — `device: [read/approve/revoke/manage]`,
  `GET`/`approve`/`revoke` routes, `withTenant`-scoped, audit on approve/revoke) is done
  verbatim: `apps/chrono-api/src/modules/device/routes.ts` has `GET /`, `POST /:id/approve`,
  `POST /:id/revoke`, `PATCH /:id/link`, all gated on the `device` permission resource
  already in `apps/chrono-api/src/auth/permissions.ts`.
- Phase 2's ask ("web UI + e2e": a `DataTable` with approve/revoke row actions, a role-gate
  + tenant-isolation spec) is done verbatim: `apps/chrono-web/src/app/dashboard/devices/
  page.tsx` has Approve/Revoke dialogs; `apps/chrono-web/e2e/tests/devices/devices.spec.ts`
  covers it.

**What is NOT done, and remains genuinely blocked**: this plan's Open Question 3 — remote
**command dispatch** (lock/unlock/reboot/force-logout a station). Checked `chronoDevice`'s
real schema (`apps/chrono-api/src/modules/device/schema.ts`): it carries only passive
`connectivityStatus`/`metadata` heartbeat fields — **no command table, no delivery
mechanism, no PC-client to execute a command even if one were queued.** This is the exact
same root blocker as `app-usage`/`app-versions`/`public-releases`: `apps/chrono-pc-client`
does not exist and is out of scope for this migration pass.

**Disposition**: this plan's original scope (Phase 1 + Phase 2, list/approve/revoke) is
redundant with landed work — do not implement it a second time under this name. The only
remaining piece — remote command dispatch — cannot be built until a PC-client exists to
receive commands. This file stays under `blocked/`, narrowed to that one residual feature;
its own historical Pass 1/Pass 2 below (written against the pre-devices sketch) is kept for
reference but its Phase 1/2 sections are superseded, not to be executed.

## What this is

A remote-management view over paired kiosk stations — distinct from `stations`' own
CRUD (venue floor-plan configuration: name a station, set its group/rate) and from the
unbuilt `devices` module's pairing/auth backend (a bearer-token machine identity for a
kiosk PC to talk to the API). This module is the **UI + control actions** layered on top
of `devices` once it exists: see which paired devices are online/offline, lock/reboot/
force-logout a station remotely, view basic health, revoke a compromised device's
pairing. Two candidate audiences per the task brief — platform-admin (`/admin/*`,
cross-tenant, Agora staff) or tenant-admin (`/dashboard/*`, per-venue staff) — this
plan's Pass 1 argues for **tenant-admin**, not platform-admin (see below), which is
itself a decision this plan makes rather than assuming.

## Pass 1 — Workflow Analysis

- **Who uses this**: a tenant `admin`/`owner` (this plan argues against platform-admin
  scope — see "Surface: tenant-admin, not platform-admin" below) managing their own
  venue's paired devices day-to-day. Not `staff` by default (remote control of a live
  customer-facing kiosk — locking/rebooting a station a customer is actively using — is
  a higher-blast-radius action than day-to-day station CRUD, which `stations`' own plan
  already gave to `staff`).
- **Workflow**: admin opens `/dashboard/devices` (or `/dashboard/stations/:id/device`) →
  sees a list of paired devices per branch (station, connectivity status, last-seen,
  approval status) → can approve a pending pairing request, revoke an approved device,
  and (once `devices` supports it) send a small set of remote commands (lock/unlock,
  force-logout the active session, reboot).
- **What they see/click**: a `DataTable` (per `.ai/rules/admin-table.md`) of devices with
  status badges, a confirm-dialog for destructive actions (revoke, reboot), Sonner toast
  on command dispatch/result.
- **Failure cases**:
  - Device offline when a command is sent → command queues or fails visibly (not a
    silent no-op) — the eventual `devices` module owns the actual delivery mechanism
    (poll-based command queue, matching oikos's `DeviceCommand` table shape, or a
    different mechanism this plan does not get to invent since it isn't `devices`' own
    plan); this plan only needs a UI state for "command pending" vs. "command failed."
  - Wrong tenant/branch → an admin must only ever see and act on their own tenant's
    devices — enforced via `withTenant`, same as every other Chrono module.
  - Revoking a device mid-session → the customer's active session should not be
    silently killed without an explicit staff-facing warning (cross-reference: session
    handling lives in the unbuilt `sessions` module too — flagged, not solved, here).
  - **Tenant-isolation leak**: identical `withTenant` discipline as every other module;
    no new leak surface beyond what `devices`' own RLS already has to get right.
- **Audit/notifications**: revoke and remote-command actions are sensitive
  (a compromised/lost kiosk PC, or a live customer-facing action) and should write an
  audit event — reuse the existing `auditEvent` foundation table/pattern
  (`agora/db/schema`) the way other sensitive Chrono mutations are expected to, once a
  precedent for tenant-level audit writes exists in a landed Chrono module to copy (not
  yet confirmed present in any landed module as of this plan — check before Phase 3 of
  whichever plan implements `devices` first, since audit-on-write is most naturally
  `devices`' own concern, inherited here).

### Surface: tenant-admin, not platform-admin — a decision, not a default

The task brief allows either "platform-admin or tenant-admin." This plan picks
**tenant-admin** (`/dashboard/*`) for the primary surface, reasoned explicitly:

- A kiosk PC belongs to one venue; the people who need to lock/reboot/troubleshoot it
  day-to-day are that venue's own staff/admin, not Agora's own platform-support team.
  Platform admins already have a narrower, legitimate cross-tenant need — e.g.
  "how many devices across all tenants are offline right now" for support triage — but
  that is a **read-only rollup**, structurally identical to how `usage`/`billing`
  platform resources are read-only aggregates over tenant-owned data via `withAdmin`
  (`.ai/rules/rbac.md`). If the developer wants that rollup, it is a small, separate,
  **additive** follow-up (a `platformDevice: ["read"]`-gated `/admin/devices` view,
  mirroring `platformApiKey`/`platformWebhook`'s shape) — not a reason to make the
  primary control surface platform-admin-owned. This plan does not build that rollup;
  it is named here so a future plan doesn't have to re-litigate the choice.
- Remote *commands* (lock/reboot/revoke) must stay tenant-admin-only regardless — a
  platform-admin issuing a live remote-control command on a tenant's physical hardware
  without that tenant's own admin initiating it is a materially different (and much
  scarier) capability than a read-only cross-tenant health rollup, and this plan
  explicitly does not propose it.

## Pass 2 — Technical Planning

### Divergence from prior art (read first)

1. **oikos's admin surface for this (`[branchCode]/station-client/...`) is entangled
   with branch-scoped routing (`[branchCode]` as a URL segment) and a JWT-bearer device
   auth path living in the same shared `middleware/auth.ts` as human session auth** —
   one `AuthContext`-shaped type trying to represent both a logged-in staff member and a
   paired device. That conflation is exactly the shape `.ai/rules/architecture.md`
   and `.ai/rules/tenant.md` push against: device identity is a **machine** credential,
   structurally different from a member session, and mixing them in one middleware/type
   risks a bug where a device credential is accidentally treated as having a `role`/
   `permissions` set it was never granted. The migration handover already calls this out
   independently for `devices` itself ("modeled on `resolveApiKeyContext()`, distinct
   from `tenantMiddleware()`") — this plan reinforces the same divergence at the
   *admin UI* layer: `admin-station-client`'s own routes are ordinary `tenantMiddleware()`
   + `requirePermission` human-session routes that happen to *read/write* device rows;
   they never authenticate as a device themselves. The device-auth path stays entirely
   inside `devices`' own module.
2. **oikos's `Device.deviceFingerprint` + unique index + partial-unique
   `(stationId, deviceType='PC_CLIENT', status='APPROVED')` constraint is sound
   design** — worth keeping conceptually once `devices`' own plan reaches schema design
   (only one approved PC-client device per station at a time). Not this plan's schema to
   define, but flagged here since this plan's UI assumes that invariant holds (a
   station's "current device" is a well-defined single row, not a list to disambiguate
   in the UI).
3. **oikos's `DeviceCommand` table (referenced, not fully inspected) implies a
   poll-based command queue** — a reasonable model for a kiosk PC that can't accept
   inbound connections (no public IP, no open port) and instead polls the API. This plan
   assumes that shape for "command pending/delivered/failed" UI states, but the actual
   queue/delivery mechanism is `devices`' own design decision, not reproduced or
   re-specified here.
4. **No rate-limiting or audit-logging gap was found specific to this admin surface in
   the code inspected** (unlike `public-stations`'/`public-releases`' genuine gaps) —
   this is an authenticated, tenant-gated, low-traffic admin surface, not a public one,
   so the abuse-prevention concerns from plans #1/#2 don't apply the same way here. The
   real gap this plan closes over prior art is the device/human auth conflation in
   point 1, not a missing rate limit.

### Schema

**Owned by `devices`' own plan, not this one.** This plan's routes read/write:
- `chronoDevice` (paired kiosk identity, connectivity status, last-seen, approval state)
- a device-command/queue table if `devices`' plan includes remote commands, or this
  plan's own Phase (once unblocked) adds a minimal `ChronoDeviceCommands` table itself if
  `devices`' plan scoped out remote commands entirely — **to be resolved when `devices`'
  plan is actually read in full**, since this plan is written before that content exists
  as working code.

### API surface (sketch, subject to `devices`' actual shape once built)

- `GET /rpc/devices` — tenant-gated, `device:read` (new Chrono permission resource,
  registered via `registerAppPermissions()` in `apps/chrono-api/src/auth/permissions.ts`,
  never added to `packages/agora`), paginated list scoped by `withTenant`.
- `POST /rpc/devices/:id/approve`, `POST /rpc/devices/:id/revoke` — `device:manage`,
  admin+-only (see Pass 1's reasoning).
- `POST /rpc/devices/:id/commands` (`{ type: "lock" | "unlock" | "reboot" |
  "force-logout" }`) — `device:manage`, admin+-only, writes a command row for the kiosk
  to pick up on its next poll (mechanism owned by `devices`).
- All permission checks module-local via a small typed wrapper
  (`apps/chrono-api/src/auth/require-permission.ts`, matching the seam
  `.ai/rules/business-app.md` describes) if the `station`/`reservation` modules already
  established one — reuse it rather than inventing a second wrapper.

### CRUD & Feedback Contract (sketch)

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Device pairing | Initiated by the kiosk itself via `devices`' pairing flow (not this admin UI) | `GET /rpc/devices` (`device:read`) | Approve (`device:manage`) | Revoke — soft (`status: "revoked"`, never a hard delete, so history/audit survives) |
| Remote command | `POST /rpc/devices/:id/commands` (`device:manage`) | Command history/status surfaced inline on the device row | — (a command is immutable once issued) | — |

- Revoke is soft-delete (`status` transition), not a row delete — matches the pattern
  elsewhere in this migration (e.g. `organization` archive/reactivate) and preserves the
  audit trail.
- Feedback: Sonner toast on approve/revoke/command-dispatch; a confirm dialog before
  revoke and before any command with real customer-facing impact (reboot,
  force-logout).
- Audit linkage: approve/revoke/command-dispatch are exactly the "sensitive confirmed
  action" category `.ai/rules/feature-planning.md`'s CRUD contract calls for — write an
  `auditEvent` row (tenant-scoped) for each.

### Web UI (sketch)

- `apps/chrono-web/src/app/dashboard/devices/page.tsx` — `DataTable` of devices
  (station, branch, connectivity badge, last-seen, status), toolbar filter by branch/
  status, row actions (approve/revoke/command) behind `<Can>` on `device:manage`.
- Confirm dialogs for revoke/reboot/force-logout, per `.ai/rules/component-first-ui.md`.

## Out of Scope (this plan, even once unblocked)

- Designing `devices` itself (schema, pairing flow, bearer-auth middleware) — that
  plan's own scope, already committed.
- The device's own PC-client software (`apps/chrono-pc-client*`) — explicitly out of
  scope for the whole migration pass per `.ai/rules/business-app.md`/the migration
  handover.
- A platform-admin cross-tenant devices rollup (`/admin/devices`) — named as a possible
  additive follow-up above, not built here.
- Live push updates for connectivity status — polling only, consistent with
  `chrono-realtime-updates` being deferred platform-wide.

## Phases

Phase 0 (`devices` schema + auth middleware) and the original Phase 1 (permission
resource + routes) and Phase 2 (web UI + e2e) are **done** — landed via `devices`' own
plan, fully archived at `.ai/plans/chrono/archive/devices/`
(`apps/chrono-api/src/modules/device/routes.ts`'s GET/approve/revoke/link,
`apps/chrono-web/src/app/dashboard/devices/page.tsx`,
`apps/chrono-web/e2e/tests/devices/devices.spec.ts`). Do not re-implement them; see the
2026-09-02 update at the top of this file for the reconciliation.

The only phase this plan still owns is **remote command dispatch**
(lock/unlock/reboot/force-logout), and it cannot be written concretely — Files to
Update, Step-by-Step Tasks, Acceptance Criteria, etc. — until the PC-client and a
command-delivery channel exist (see "Unblocking" below). Once unblocked, this section
gets a real Phase 3 built against `devices`' actual command vocabulary at that time —
not sketched in advance here.

## Open Questions (developer to confirm/override)

1. Staff read-only access to the device list (this plan currently gives staff nothing,
   matching `devices`' own noted default of admin+ for approve/revoke) — reconsider once
   `devices`' plan is actually read in full; this plan should not diverge from whatever
   `devices` itself settles on without a reason.
2. Platform-admin cross-tenant rollup — build as a true follow-up plan, or fold into
   this plan's scope later. This plan currently keeps it out.
3. Remote-command set (lock/unlock/reboot/force-logout) is a guess at what's operationally
   useful, not sourced from a confirmed `devices` command vocabulary — confirm against
   `devices`' actual schema once it exists; the set may be smaller (or larger) in
   practice.

## Unblocking

Moves from `.ai/plans/chrono/blocked/admin-station-client/` to
`.ai/plans/chrono/draft/admin-station-client/` only if/when a PC-client app is
commissioned and a command-delivery channel (queue table + device polling/push) is
designed for it — the only remaining scope this plan owns is remote command dispatch
(lock/unlock/reboot/force-logout). List/approve/revoke is already live; do not re-plan
or re-implement it here.

## After Implementation

Not applicable until unblocked — see `.ai/rules/feature-planning.md`'s "After
Implementation" for the report shape to use once phases actually run.
