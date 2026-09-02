# Chrono — `devices` module

**Depends on:** `stations` (plan done/committed at `557b43e`; implementation not started as
of this writing). A device optionally belongs to a station
(`stationId: text("stationId").references(() => chronoStation.id, { onDelete: "set null" })`,
importing `chronoStation` from `apps/chrono-api/src/modules/station/schema.ts`) — the FK
lives on the device row, exactly as `stations`' own plan forward-referenced. This plan
assumes `chronoStation`/`ChronoStations` exists by the time `devices`' own Phase 1
executes; it does not block on `stations`' full implementation landing first (same
convention `stations` used for `branches`). `sessions` (planned last, separately) will
read `ChronoDevices.stationId`/`lastSeenAt`/`status` and extend this module's
device-facing endpoints once it exists — see "Forward references for `sessions`" below.

---

## ⚠️ Read this before anything else — this module is NOT shaped like `branches`/`stations`

Every other Wave-1 module so far is a straightforward tenant-scoped CRUD resource:
a signed-in staff member, through a browser session, hits `/rpc/*` behind
`tenantMiddleware()` and `requirePermission`. **`devices` has that surface too (staff
approve/revoke/list), but it also has a second, structurally different surface that
none of this codebase's precedent covers**: the device itself — kiosk/PC-client
**hardware**, not a human — calls the API to register, prove its identity on every
request, and report liveness. There is no signed-in user, no Better Auth session, and
no tenant membership row behind that traffic. `c.var.tenant` does not exist for it.
`requirePermission(c.var.tenant.permissions, ...)` is therefore the **wrong gate** for
every device-originated route — that machinery assumes a resolved human/API-key actor
that a bare PC client will never have.

This plan designs a **separate, module-local device-auth middleware**
(`apps/chrono-api/src/modules/device/device-auth-middleware.ts`) that authenticates a
device's own bearer credential directly against `ChronoDevices`, independently of
`tenantMiddleware()`. **This middleware's design is the single biggest open question in
this plan** — it is genuinely novel territory in this codebase (see "Open Question 1 —
the device-auth middleware design" below) and deserves a deliberate developer read,
not a rubber stamp.

Concretely, this module has **two disjoint route surfaces, gated two different ways**:

| Surface | Actor | Auth | Mount point |
|---|---|---|---|
| Device-facing (`/pair`, `/auth`, `/heartbeat`) | the PC-client hardware itself | module-local device-bearer-token middleware (this plan) | `apps/chrono-api/src/app.ts`, outside `/rpc` and outside `tenantMiddleware()` |
| Staff-facing (list, approve pending, revoke) | a signed-in tenant staff member | normal `tenantMiddleware()` + `requirePermission` | `/rpc/devices`, inside `apps/chrono-api/src/routes/rpc.ts` like every other module |

Every route in Pass 2 below is labeled with which column it's in. Do not gate a
device-facing route with `requirePermission`, and do not gate a staff-facing route with
the device-bearer middleware — mixing them up is the one mistake this whole plan exists
to prevent.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **The PC client itself (hardware, not a person)** — on first boot, prompts whoever is
  setting it up to type in a short pairing code (or, for a diskless/cloned image, uses a
  provisioning token baked into the image); the API registers it as
  `pending_approval`; every subsequent boot the client re-authenticates with its own
  stored device token and sends periodic heartbeats.
- **Owner / Admin** — generates pairing codes / provisioning tokens for new hardware,
  sees the list of registered devices (pending + approved + revoked) per branch,
  approves a pending device (assigning it to a station), revokes a device that's lost,
  stolen, or decommissioned.
- **Staff** — read-only visibility into the device list this pass (see Open Question 2
  for whether staff should also approve/revoke, matching oikos's more permissive
  precedent).
- **Platform admin (`/rpc-admin`)** — not built in this pass, same deferral
  `branches`/`stations` made (see Out of Scope).

**Workflow:** An admin opens **Dashboard → Devices**, clicks **Generate Pairing Code**,
picks a branch, gets back an 8-character code with a short expiry (e.g. 60 minutes) to
read aloud/type at the physical PC. The PC-client software (not built in this migration
pass — see `.ai/rules/business-app.md`'s "Out of scope" list; this plan only builds the
server side of the protocol it will speak) calls `POST /api/v1/device/pair` with that
code, gets back a provisioning token, then immediately calls `POST /api/v1/device/auth`
with that token + a hardware fingerprint it computes locally. The API creates a
`ChronoDevices` row in `pending_approval` and returns the device its own permanent,
per-device bearer token. The device stores that token locally (its own concern, not
this plan's) and shows a "waiting for approval" screen. Back in the dashboard, the admin
sees the new row under **Pending**, picks a station for it (or lets the API create one),
and clicks **Approve** — the device flips to `approved` and can now authenticate with
its stored token on every future request via the device-bearer middleware. Revoking a
device immediately blocks its bearer token (checked on every request, not just at issue
time) and frees its station.

**Failure cases:**

- Pairing code expired/unknown → `/pair` returns 400, the client shows "invalid or
  expired code," never leaking whether ANY code was close to matching.
- A device presents a bearer token that doesn't hash-match any `ChronoDevices` row →
  401, same response whether the token is malformed, unknown, or well-formed-but-wrong —
  never distinguishes so a brute-force attempt learns nothing.
- A device presents a valid token but has been revoked (or is still `pending_approval`)
  → 403, distinct from 401 (the credential itself is fine, the device just isn't allowed
  through right now) — mirrors oikos's own 401-vs-403 split.
- A **cloned** device — same provisioning-token-derived credential, different hardware
  fingerprint — re-authenticating at `/auth` is treated as a re-pairing attempt: the
  fingerprint on file is NOT silently overwritten; the row is bumped back to
  `pending_approval` so an admin has to knowingly re-approve it. This is a real security
  property from oikos (disk-cloned/duplicated images are the actual attack this
  defends against for a diskless-clone shop) and this plan keeps it.
- Staff attempts approve/revoke as a non-privileged role → 403 `Forbidden`, gated by
  `requirePermission` (see Open Question 2 for exactly which role tier).
- Approving a device onto a station that already has another approved device linked →
  409 (mirrors oikos's partial-unique-index guard, ported below).
- Wrong tenant/host on the staff-facing routes → `tenantMiddleware()` never resolves
  `c.var.tenant`, request never reaches the handler (same as every other module).
- **Tenant-isolation leak scenario**: tenant A's device-bearer token must never
  authenticate against tenant B's data even if an attacker somehow guessed a
  syntactically valid token — the lookup is by hash against `ChronoDevices.tokenHash`,
  a column with no tenant-scoping ambiguity (one row = one tenant, full stop), and the
  resolved `tenantId` used for every subsequent `withTenant` call comes from THAT row,
  never from a header or body field. On the staff side, tenant B must never see tenant
  A's device rows in its list (RLS), and a direct id-based approve/revoke against
  tenant A's device 404s from tenant B's session (never 403 — no existence leak).
- Stale screen: two admins approving the same pending device — last write wins, but the
  station-conflict 409 above prevents two devices from ending up on the same station
  even under a race (DB-level partial unique index, not just an application check).

**Audit / notifications:** every staff-triggered mutation (pairing-token generated,
device approved, device revoked, device relinked to a different station) writes a
`recordStaffAudit` entry (`device.pairing_token_created` / `device.approved` /
`device.revoked` / `device.relinked`), matching the `project`/`branch`/`station`
pattern. Device-originated writes (heartbeat, `/auth` registration) are system traffic,
not staff actions — they do **not** go through `recordStaffAudit` (there is no staff
actor), matching how `emitTenantEvent`/system-authored rows work elsewhere in this
codebase. No webhook event in this pass — same deferral `branches`/`stations` made.

---

## Pass 2 — Technical Planning

### What exists today in oikos, and how this plan reads it

Four separate folders under `apps/chrono-api/src/modules/` in oikos all touch "devices,"
and they are **not** one concept split across folders for no reason — they are three
(really four, counting where the actual staff CRUD lives) genuinely different concerns
that happen to share a noun:

1. **`modules/device`** (singular) — the actual kiosk/PC-client-facing HTTP surface:
   `POST /pair`, `POST /auth`, `POST /heartbeat`, `GET /status`, `POST /sync-events`,
   plus session-start/away-unlock/security-alert-report endpoints. This is the
   device-authenticated surface with no staff session at all — **this is what "device
   pairing" means**, and it's the core of this plan.
2. **`modules/devices`** (plural) — `SUPER_ADMIN`-only, **cross-tenant** device
   management: list every tenant's devices, revoke, reassign an update channel. This is
   a **platform-admin** surface, not a tenant one — see Out of Scope.
3. **`modules/device-commands`** — remote command dispatch to an already-paired,
   already-online device (`LOCK`/`UNLOCK`/`RESTART`/`SHUTDOWN`/`SCREENSHOT`/etc.),
   delivered over Socket.IO with HMAC-SHA256-signed envelopes
   (`apps/chrono-api/src/lib/command-auth.ts`), ack/retry/webhook-fallback delivery, and
   a `DeviceCommand` row per dispatch. **This is genuinely a separate, heavier concern**
   from pairing/registration: it needs realtime transport (Socket.IO or an equivalent),
   which does not exist anywhere in the agora Hono stack today, and it operates on
   devices that are already `approved` and paired to a station running (or about to
   run) a session — i.e. it is naturally `sessions`-adjacent, not `devices`-adjacent.
   **Deferred out of scope for this plan entirely** — a future module, not this one, and
   not silently folded in as "just another route."
4. **`modules/admin-station-client`** — this is where oikos's actual **staff-facing**
   approve/revoke/relink/list-pending/pairing-code-generation routes live (role-gated
   `['OWNER', 'STAFF']` throughout), interleaved with PC-client *behavioral* settings
   (`autoUpdate`, `lockOnStartup`, `minChargeAmount`/`minChargeMinutes` — a min-charge
   floor for how billing rounds a short session, which is `sessions`/billing territory,
   not device territory) that have no agora PC-client counterpart to configure yet.
   `admin-station-client` is on `.ai/handover/chrono-migration.md`'s deferred list as a
   whole module — but the task that produced this plan explicitly requires staff-facing
   device CRUD (list, approve, revoke) to exist. **This plan extracts only the
   device-lifecycle subset** (pairing-token generation, list pending, approve, revoke,
   relink) into `devices`' own staff-facing routes, and leaves the PC-client behavioral
   settings (`autoUpdate`/`lockOnStartup`/min-charge) deferred with the rest of
   `admin-station-client` — they belong with whatever module eventually owns PC-client
   configuration, not with device pairing.

### The actual oikos auth mechanism — and where this plan deliberately simplifies it

The task that produced this plan described oikos's device auth as
"`X-Device-Fingerprint` + `X-Device-Token` headers." Having read
`apps/chrono-api/src/middleware/auth.ts` directly, that describes only oikos's
**fallback** path. The real picture is a two-layer scheme:

- **Primary**: `requireDeviceBearerAuth` expects `Authorization: Bearer <jwt>` — a
  short-lived (8h) HS256 JWT minted by `/auth` (`createDeviceAccessToken`), signed with
  the server's global `config.jwtSecret`, carrying `deviceId`/`tenantId`/`branchId`/
  `stationId` as claims. Every request re-verifies the JWT signature+expiry, THEN
  re-checks the device's live status from the DB (`getDeviceStatus`, 30s-TTL cached) so
  a revoked device loses access within 30s instead of waiting out the full 8h token
  lifetime.
- **Fallback**: if JWT verification throws (expired, malformed, wrong secret), it falls
  through to `requireDeviceAuth` — the raw `X-Device-Fingerprint` + `X-Device-Token`
  header pair, hashed and looked up directly against `ChronoDevices`-equivalent
  (`Device.deviceTokenHash` + `Device.deviceFingerprint`, both must match).

**This plan intentionally drops the JWT layer.** The JWT in oikos is a *derived cache*
of the real credential (the raw device token) — it exists purely so a hot request path
avoids a DB hit on every call, at the cost of a second signing secret and a second
credential format to keep in sync. Agora has no existing per-app JWT-signing convention
to hang this on, and `.ai/rules/database.md` already prefers a single source of truth
for a credential over a derived one. This plan uses **one mechanism**: every
authenticated device request sends `Authorization: Bearer <rawDeviceToken>` PLUS
`X-Device-Fingerprint: <fingerprint>` (both — not either/or), and the module-local
middleware hashes the presented token and verifies it **and** the fingerprint against
the same `ChronoDevices` row on every call (no JWT, no 8h grace window — a revoked
device is rejected on its very next request, which is a strictly *tighter* security
property than oikos's 30s-cached JWT-plus-recheck approach, achieved with a simpler
mechanism). The fingerprint check is kept (not just the bearer token) because it is
oikos's actual clone/theft-detection property — a stolen bearer token alone should not
authenticate from different hardware.

**Open Question 1 — the device-auth middleware design (resolve before Phase 3, the
single most important thing to review in this plan):** with no JWT and no
`tenantMiddleware()`, the device-auth middleware faces a chicken-and-egg problem every
other route in this codebase avoids: **the tenant is not known until after the
credential is looked up**, and `withTenant(tenantId, ...)` needs a `tenantId` to scope
its query. Nothing already-migrated in this codebase authenticates a non-human,
non-session, non-Better-Auth-API-key actor.

The precedent this plan follows is `packages/agora/src/server/tenant.ts`'s
`resolveApiKeyContext()` — the ONE place in the existing foundation that already solves
exactly this problem for a different actor kind (a tenant API key, also a bearer
secret, also tenant-unknown-until-resolved):

1. Parse the presented secret from the header(s) (no tenant yet).
2. Hash it and look the row up via **`withAdmin`** (RLS-bypassing, single-connection
   safe — this is the ONLY step in the whole flow that legitimately reads across
   tenants, and it does so by an indexed hash column, never a scan). Reuse
   `hashApiKey`/`verifyApiKey` from `agora/server` (`packages/agora/src/server/api-key.ts`)
   directly — they are already generic SHA-256-hex-plus-`timingSafeEqual` primitives
   with no `agora_`-prefix assumption baked into the verify path (only
   `parseApiKeyPrefix`/`looksLikeApiKey` are key-format-specific, and this plan does not
   need those). No new hashing utility needed.
3. Reject (401) if no row matches, or the fingerprint doesn't match, or the token hash
   doesn't match (constant-time compare either way).
4. Reject (403) if the matched row's `status` isn't `approved`.
5. Set a **distinct** `c.var.device` context (deviceId/tenantId/branchId/stationId/
   status) — never merged into or aliased with `TenantVars`/`c.var.tenant`. A device is
   not a tenant actor and must never accidentally satisfy a check written for one.
6. From here on, the route handler's own DB work uses `withTenant(deviceCtx.tenantId,
   tx => ...)` exactly like every other tenant-scoped route — the cross-tenant lookup
   is confined to step 2 alone.

This mirrors `resolveApiKeyContext()`'s shape closely enough to be low-risk, but it is
still new: it is the first time this codebase authenticates a **non-human** actor, the
first module-local (not foundation-level) auth middleware, and the first time
`withAdmin` is used for a credential lookup outside `packages/agora` itself. **Flag this
whole design to the developer before Phase 3 starts** — if a different shape is
preferred (e.g. promoting this to a foundation-level `agora/server` helper rather than
module-local, given it is structurally identical to the API-key case), that is a
cheap change now and an expensive one after Phase 3-6 are built on top of it.

### Pattern to copy in agora (worked example: `station`, one level removed from `branch`)

- `apps/chrono-api/src/modules/station/schema.ts` — table shape, `text`/`createId()`
  ids, tenant + entity indexes, composite unique indexes, importing a sibling module's
  table directly (`chronoBranch` from `../branch/schema`) rather than through
  `../../db/schema` (avoids a circular import through the composition file) — this plan
  does the same for `chronoStation`.
- `apps/chrono-api/src/db/schema.ts` — re-export + `APP_TENANT_TABLES` composition
  point.
- `apps/chrono-api/src/routes/rpc.ts` — the `project`/`file`/`station` GET (paginated)/
  POST/PATCH/DELETE (`requirePermission`) shape, `withTenant`, `recordStaffAudit` — this
  is the pattern for the **staff-facing** half of this module only.
- `packages/agora/src/server/tenant.ts`'s `resolveApiKeyContext()` +
  `packages/agora/src/server/api-key.ts` — the pattern for the **device-facing** half
  (Open Question 1 above).
- `apps/chrono-api/src/app.ts` — where pre-tenant-context public routes already mount
  directly on `app` outside `/rpc`/`tenantMiddleware()`: `/billing/webhook`,
  `/internal/domains/recheck`, the whole `/public/*` family. The device-facing routes
  in this plan mount the same way, not through `rpc` or `apiV1`.
- `.ai/rules/business-app.md` — module folder `apps/chrono-api/src/modules/device/`
  (singular, matching oikos's own naming for the actual pairing/registration concept —
  see "What exists today" above for why `devices`/`device-commands` are explicitly NOT
  folded in here).

### Schema — `ChronoDevices` + `ChronoDeviceProvisioningTokens`

New file `apps/chrono-api/src/modules/device/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex, integer, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";

export const chronoDeviceProvisioningToken = pgTable(
  "ChronoDeviceProvisioningTokens",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Short, human-typed-at-the-PC code (staff-generated, short TTL). Cleared
    // to null once expired is NOT required — expiry is checked at lookup time
    // (pairingCodeExpiresAt), matching the tokenHash side below.
    pairingCode: text("pairingCode"),
    pairingCodeExpiresAt: timestamp("pairingCodeExpiresAt"),
    // Minted by /pair the first time pairingCode is redeemed; the device's own
    // /auth call presents this. Reusable across multiple PCs cloned from the
    // same golden image (maxUses/useCount), matching oikos's diskless-clone
    // provisioning path — see Pass 1.
    tokenHash: text("tokenHash"),
    tokenExpiresAt: timestamp("tokenExpiresAt"),
    status: text("status").notNull().default("active"), // "active" | "revoked"
    maxUses: integer("maxUses"),
    useCount: integer("useCount").notNull().default(0),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_device_prov_token_tenant_idx").on(t.tenantId),
    index("chrono_device_prov_token_branch_idx").on(t.branchId),
    // Not globally unique on purpose — pairing codes are short-lived and
    // scoped by (status=active AND expiresAt>now) at lookup time, not by DB
    // uniqueness; a plain index is enough to make the cross-tenant lookup
    // (Open Question 1, step 2) an index scan instead of a table scan.
    index("chrono_device_prov_token_pairing_code_idx").on(t.pairingCode),
    uniqueIndex("chrono_device_prov_token_hash_idx").on(t.tokenHash),
  ],
);

export const chronoDevice = pgTable(
  "ChronoDevices",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // Nullable — a brand-new pending_approval device may not have a station
    // yet; devices' own approve step assigns/creates one. onDelete: "set null"
    // matches stations' own forward-reference (deleting a station un-pairs its
    // device rather than orphaning device history).
    stationId: text("stationId").references(() => chronoStation.id, { onDelete: "set null" }),
    deviceFingerprint: text("deviceFingerprint").notNull(),
    // SHA-256 hex of the device's own permanent bearer token. Never store the
    // raw token — .ai/rules/database.md.
    tokenHash: text("tokenHash").notNull(),
    // "pending_approval" | "approved" | "revoked" — free text per the
    // dominant agora convention (branches'/stations' own `status` columns),
    // not a pg enum.
    status: text("status").notNull().default("pending_approval"),
    connectivityStatus: text("connectivityStatus").notNull().default("offline"), // "online" | "offline"
    hostname: text("hostname"),
    ipAddress: text("ipAddress"),
    clientVersion: text("clientVersion"),
    osVersion: text("osVersion"),
    lastSeenAt: timestamp("lastSeenAt"),
    approvedByUserId: text("approvedByUserId").references(() => base.user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approvedAt"),
    // Free-form heartbeat telemetry (lockState/runtimeStatus/uptime/etc.) —
    // genuinely dynamic, mirrors oikos's own metadataJson catch-all.
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_device_tenant_idx").on(t.tenantId),
    index("chrono_device_branch_idx").on(t.branchId),
    index("chrono_device_station_idx").on(t.stationId),
    uniqueIndex("chrono_device_tenant_fingerprint_idx").on(t.tenantId, t.deviceFingerprint),
    uniqueIndex("chrono_device_token_hash_idx").on(t.tokenHash),
    // Mirrors oikos's uq_Devices_stationId_approved_pc_client: at most one
    // APPROVED device may be linked to a given station at a time. Enforced at
    // the DB level so a race between two concurrent approvals can't both win.
    uniqueIndex("chrono_device_station_approved_idx")
      .on(t.stationId)
      .where(sql`${t.stationId} is not null and ${t.status} = 'approved'`),
  ],
);
```

### `APP_TENANT_TABLES`

Add `"ChronoDeviceProvisioningTokens"` and `"ChronoDevices"` to the array in
`apps/chrono-api/src/db/schema.ts` (provisioning tokens before devices, matching the
FK direction), and re-export both from the module into that file (same composition
point already used for `chronoBranch`/`chronoStation`).

**Note on RLS and the device-facing lookup**: both tables are still RLS-forced tenant
tables, same as everything else — the ONLY place that legitimately reads across
tenants is the credential lookup itself (Open Question 1, step 2, via `withAdmin`).
Every other read/write in this module, staff-facing or device-facing, is scoped by
`withTenant` once a `tenantId` is known.

### Contracts — `apps/chrono-api/src/modules/device/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const deviceStatusSchema = z.enum(["pending_approval", "approved", "revoked"]);

// ── Device-facing (no staff session) ──
export const pairDeviceSchema = z.object({
  pairingCode: z.string().min(1).max(32),
});

export const authDeviceSchema = z.object({
  fingerprint: z.string().min(1).max(512),
  hostname: z.string().max(255).optional(),
  provisioningToken: z.string().min(1),
});

export const heartbeatSchema = z.object({
  lockState: z.string().max(50).optional(),
  runtimeStatus: z.string().max(50).optional(),
  clientVersion: z.string().max(50).optional(),
  osVersion: z.string().max(100).optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
});

// ── Staff-facing ──
export const createProvisioningTokenSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(255),
  // Minutes until the human-facing pairing code expires. Short by design —
  // oikos used 60.
  pairingCodeTtlMinutes: z.number().int().positive().max(24 * 60).default(60),
  // Optional cap for golden-image reuse across many PCs; omitted = unbounded.
  maxUses: z.number().int().positive().max(1000).optional(),
});

export const approveDeviceSchema = z.object({
  // Assign to an existing station, or omit to create one from name/number.
  stationId: z.string().min(1).optional(),
  newStationName: z.string().min(1).max(255).optional(),
  newStationNumber: z.string().min(1).max(50).optional(),
});

export const relinkDeviceSchema = z.object({
  stationId: z.string().min(1),
});

export const deviceListQuerySchema = listQuerySchema([
  "hostname",
  "createdAt",
  "lastSeenAt",
]).extend({
  branchId: z.string().optional(),
  status: deviceStatusSchema.optional(),
});

export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
export type PairDeviceInput = z.infer<typeof pairDeviceSchema>;
export type AuthDeviceInput = z.infer<typeof authDeviceSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type CreateProvisioningTokenInput = z.infer<typeof createProvisioningTokenSchema>;
export type ApproveDeviceInput = z.infer<typeof approveDeviceSchema>;
export type RelinkDeviceInput = z.infer<typeof relinkDeviceSchema>;
```

### Device-auth middleware — `apps/chrono-api/src/modules/device/device-auth-middleware.ts`

Implements Open Question 1's design:

```ts
export type DeviceAuthContext = {
  deviceId: string;
  tenantId: string;
  branchId: string;
  stationId: string | null;
  status: "pending_approval" | "approved" | "revoked";
};
export type DeviceAuthVars = { device: DeviceAuthContext };

export function requireDeviceBearerAuth(): MiddlewareHandler<{ Variables: DeviceAuthVars }> {
  // 1. Parse `Authorization: Bearer <token>` + `X-Device-Fingerprint` headers.
  //    Missing either -> 401.
  // 2. hashApiKey(token) (reused from agora/server), look up ChronoDevices by
  //    tokenHash via withAdmin. No match -> 401 (same response as malformed).
  // 3. Constant-time-verified hash match AND deviceFingerprint match required
  //    -> 401 on mismatch (never reveal which check failed).
  // 4. status !== "approved" -> 403.
  // 5. c.set("device", { deviceId, tenantId, branchId, stationId, status }).
}
```

Never merged into `TenantVars`; never touches `c.var.tenant`.

### Routes — device-facing, `apps/chrono-api/src/modules/device/routes.ts`

A Hono factory `deviceAuthRoutes()`, mounted directly on `app` in
`apps/chrono-api/src/app.ts` via `.route("/api/v1/device", deviceAuthRoutes())` —
**outside** `/rpc`, **outside** `apiV1`'s `tenantMiddleware()`, alongside
`/billing/webhook` and the `/public/*` family:

- `POST /pair` — **unauthenticated** (the pairing code itself is the secret, short-TTL).
  Cross-tenant lookup via `withAdmin` on `ChronoDeviceProvisioningTokens` by
  `pairingCode` where `status = 'active' AND pairingCodeExpiresAt > now()`. No match →
  400 (`Invalid or expired pairing code`, never distinguishes expired-vs-unknown). On
  match: mint a fresh provisioning token (random bytes, hashed via the same
  `agora/server` primitive), store `tokenHash`/`tokenExpiresAt` on that SAME row
  (`withTenant(row.tenantId, ...)` now that tenant is known), increment nothing yet
  (useCount increments on `/auth`, not here — matches oikos), return the raw
  provisioning token + `tenantId`/`branchId` to the caller **once**.
- `POST /auth` — **unauthenticated** (this IS the credential-issuing step). Hashes the
  presented `provisioningToken`, looks it up cross-tenant via `withAdmin` against
  `ChronoDeviceProvisioningTokens.tokenHash` (active, unexpired, under `maxUses`) **or**
  an existing `ChronoDevices.tokenHash` (a device re-authenticating with its own
  already-issued token). Branches exactly like oikos's `/auth` (Pass 1's "Failure
  cases" walks through the re-pairing/clone-detection behavior):
  - New fingerprint + valid provisioning token → insert `ChronoDevices` row
    (`pending_approval`), mint a fresh device token (own hash, distinct from the
    provisioning token), increment the provisioning token's `useCount`, return the raw
    device token.
  - Known fingerprint, but a DIFFERENT tokenHash on file (re-pairing / cloned image) →
    update the row's `tokenHash` and reset `status` to `pending_approval` — never
    silently trust a fingerprint match alone.
  - Known fingerprint + known tokenHash (idempotent re-auth) → return current status,
    no new token minted.
  All branches run inside `withTenant(tenantId, ...)` once the owning tenant is
  resolved from the provisioning-token/device row.
- `POST /heartbeat` — **device-bearer-protected** (`requireDeviceBearerAuth()`).
  `zValidator("json", heartbeatSchema)`. `withTenant(device.tenantId, tx => ...)`
  updates `lastSeenAt = now()`, `connectivityStatus = 'online'`, merges `metadata`.
  Returns `{ status: "ok", timestamp }` only — **no session/pricing/reservation payload**
  (see "Deliberately narrowed" below; that's `sessions`' concern once it exists).

**Deliberately narrowed from oikos's device-facing surface:**

- `GET /status`, `POST /sync-events`, the session-start/away-unlock endpoints, and the
  security-alert-report endpoint are **not built in this pass**. oikos's versions of
  these are deeply entangled with `DeviceSession`/`Reservation`/`CreditGrants`/
  `PricingRule`/`SecurityAlert` — none of which exist yet (`sessions` is the last
  Wave-1 module; `security-alerts` is on the deferred list entirely). Building a
  device-facing session/pricing response now, against tables that don't exist, would be
  exactly the "business-specific module nobody asked for yet" `.ai/rules/ai-agent.md`
  warns against. `/heartbeat`'s response is deliberately minimal and honest about what
  this module actually knows (device identity + liveness) rather than a placeholder
  shape for data that isn't there yet.
- `device-commands` (remote lock/unlock/reboot/shutdown dispatch) — confirmed separate
  concept, confirmed out of scope, see "What exists today" above.

**Decision recorded (`security-hardening` Phase 1, 2026-09-02) — `/pair` is
single-redemption, not concurrently multi-PC:** the original `/pair` handler
overwrote `ChronoDeviceProvisioningTokens.tokenHash` on every redemption, which
meant a second PC re-pairing with the same code (the stated `maxUses > 1`
golden-image flow) silently invalidated the first PC's already-issued
credential. Resolved as **enforce single-redemption**: once a `/pair` call has
set `tokenHash` and no `/auth` call has yet consumed it (`useCount` still `0`,
`tokenExpiresAt` not passed), a second `/pair` for the same `pairingCode` is
refused with `409` ("This pairing code has already been redeemed and is
awaiting device authentication.") instead of overwriting the hash. Once `/auth`
successfully consumes it — or the code/token expires — a fresh `/pair` call
(same code) is allowed again. **True simultaneous multi-PC pairing from one
still-unconsumed code is NOT supported in this pass** — that is an accepted,
documented limitation, not a bug to route around. The reusability
`maxUses`/`useCount` was designed for continues to work exactly as before
*after* the first `/auth` call: multiple already-`/auth`'d PCs share the
golden-image token; it is only the pre-`/auth` `/pair` step that is now
single-shot. Implemented via a conditional `UPDATE ... WHERE` (not the earlier
`SELECT`) so a concurrent `/pair` race can't both win — see
`apps/chrono-api/src/modules/device/routes.ts`'s `/pair` handler.

### Forward references for `sessions`

- `sessions`' own plan will need to extend `POST /heartbeat`'s response (and likely add
  back a `GET /status` and session-start endpoint) once `ChronoSessions` exists, to
  surface active-session/scheduled-end/balance data to the PC client the way oikos's
  full heartbeat does. This plan deliberately does not guess that shape now.
- `sessions` reads `ChronoDevices.stationId`/`connectivityStatus`/`lastSeenAt` to know
  whether a station's paired hardware is online before starting/ending a session — a
  read-only dependency, no schema change required on this table for that.

### Routes — staff-facing, `apps/chrono-api/src/modules/device/routes.ts`

A second Hono factory `staffDeviceRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/devices", staffDeviceRoutes())` —
**inside** `/rpc`, using the chain's existing `tenantMiddleware()`:

- `GET /` — **ungated** (any authenticated tenant member can view the device list —
  matches branches'/stations' own ungated-list precedent). `zValidator("query",
  deviceListQuerySchema)`, optional `branchId`/`status` filters, `withTenant`, `{ items,
  meta }` (`buildPaginationMeta`).
- `POST /provisioning-tokens` — `requirePermission(c.var.tenant.permissions, { device:
  ["manage"] })`. Validates `createProvisioningTokenSchema`. Branch-ownership check
  (branchId belongs to caller's tenant) before insert, same lookup-before-insert
  pattern `stations` established. `recordStaffAudit({ action:
  "device.pairing_token_created", ... })`. Returns the row **including the plaintext
  pairing code** (it's short-lived and meant to be read aloud — this is the one place
  in this module a secret-shaped value is legitimately returned, distinct from the
  device's own bearer token, which is never re-exposed after `/auth`).
- `GET /provisioning-tokens` — `requirePermission(..., { device: ["manage"] })`.
  Paginated list, **never returns `tokenHash`**.
- `POST /provisioning-tokens/:id/revoke` — `requirePermission(..., { device:
  ["manage"] })`. Flips `status` to `revoked` (blocks new `/pair` redemptions and new
  `/auth` registrations against it immediately; already-approved devices are
  unaffected — they authenticate with their own token, not the provisioning token).
  `recordStaffAudit`.
- `POST /:id/approve` — `requirePermission(..., { device: ["approve"] })`. Validates
  `approveDeviceSchema`. Resolves target station: an explicit `stationId` (verified to
  belong to the same branch/tenant, 404 otherwise) or `newStationName`/
  `newStationNumber` (creates one via the same insert shape `stations`' own `POST /`
  uses). 409 (`Station already linked to another approved device`) on conflict — the
  application-level pre-check AND the DB partial unique index both guard this, matching
  oikos's belt-and-suspenders approach for the concurrent-approval race. Sets `status =
  'approved'`, `stationId`, `approvedByUserId`, `approvedAt`. `recordStaffAudit({
  action: "device.approved", ... })`.
- `POST /:id/revoke` — `requirePermission(..., { device: ["revoke"] })`. Sets `status =
  'revoked'`. If linked to a station, does **not** touch the station's own `status`
  column (that's `sessions`'/floor-occupancy's concern once a station's `status` is
  actually driven by live session state — see `stations`' own plan's reserved
  `"occupied"` value discussion). `recordStaffAudit({ action: "device.revoked", ... })`.
- `PATCH /:id/link` — `requirePermission(..., { device: ["manage"] })`. Validates
  `relinkDeviceSchema`. Same station-ownership + conflict checks as approve, but for an
  already-approved device being moved to a different station. `recordStaffAudit({
  action: "device.relinked", ... })`.

No `DELETE /devices/:id` in this pass — a device is retired via `revoke`, not deleted
(same "no hard delete without a reason" posture `branches` took; unlike `stations`,
there's no clean analogue to "nothing downstream references it yet" since a revoked
device's history — approval trail, last-known station — is worth keeping).

### Permission vocabulary

**Open Question 2 (resolve before Phase 4):** oikos gates ALL of approve/revoke/relink/
pairing-token-management `['OWNER', 'STAFF']` — i.e. full staff parity, no admin-only
tier, unlike `branches`' owner-only or `stations`' staff-create-update-not-delete split.
This plan takes the **stricter** position by default — device pairing is a
hardware-trust decision (approving a device grants it the ability to authenticate as
that station's kiosk indefinitely; revoking is the only lever against a lost/stolen
PC) closer in risk profile to `domain`/`branding`/`integration` (admin+ only) than to
`station`'s day-to-day floor reconfiguration.

**Superseded 2026-09-02**: the "add directly to `packages/agora/src/auth/permissions.ts`"
precedent this plan originally cited has been retired — see
`.ai/plans/agora/active/permission-extension-seam/README.md` and
`.ai/rules/business-app.md`, "Permissions: the per-app extension seam." `device` must be
added to `apps/chrono-api/src/auth/permissions.ts` (alongside
`branch`/`station`/`shift`/`reservation`) instead, following that file's existing
pattern:

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  device: ["approve", "revoke", "manage"],
} satisfies Record<string, string[]>;
```

Add `device: ["approve", "revoke", "manage"]` to `CHRONO_ADMIN_GRANTS` only in that same
file — no code changes needed elsewhere; `registerChronoPermissions()` already registers
whatever this file defines. Route files under `apps/chrono-api/src/modules/device/`
should import `requirePermission` from `apps/chrono-api/src/auth/require-permission.ts`
(the typed wrapper), not `agora/auth` directly, so `device:*` calls keep compile-time
key/action checking — same as `branch`/`station`/`shift`/`reservation`'s route files
already do.

- `CHRONO_STAFF_GRANTS` — **not added** (mirrors `branches`' precedent: no staff-level
  device mutation this pass; GET stays ungated so staff retain read visibility).
- `CHRONO_ADMIN_GRANTS` — `device: ["approve", "revoke", "manage"]`.
- `owner` — inherits automatically (every statement).

If the developer wants oikos's parity instead (staff can approve/revoke/manage, same as
stations' staff tier), that's a one-line addition of `device: ["approve", "manage"]` (or
all three) to `CHRONO_STAFF_GRANTS` — flagging now so it's a deliberate choice, not a
default nobody noticed. Note this plan does NOT give `create`/`read`/`update`/`delete` action
names to this resource — the three real lifecycle verbs (`approve`/`revoke`/`manage`)
map onto actual distinct routes, per `.ai/rules/rbac.md`'s "every action maps to a real
gate" rule; a generic `update` would be unused (there is no route that does a bare field
edit) and `create`/`delete` don't correspond to anything a staff actor does to a device
row directly (creation happens device-side at `/auth`; there is no delete).

### Web UI — `apps/chrono-web/src/app/dashboard/devices/`

- `page.tsx` — client component (mirrors `apps/chrono-web/src/app/dashboard/stations/page.tsx`'s
  branch-filtered pattern): `useListQuery(["branchId", "status"])`,
  `api.rpc.devices.$get({ query: {...} })`, `DataTable`/`DataTableGrid` +
  `DataTableToolbar` + `DataTablePagination` from `agora/ui`. Status filter chips
  (Pending / Approved / Revoked) alongside the branch `Select`.
- A **Generate Pairing Code** `Dialog` (branch `Select`, name, optional max-uses):
  submits to `POST /rpc/devices/provisioning-tokens`, then shows the returned plaintext
  code + expiry in a copyable/read-aloud-friendly display — this is the one screen in
  this module that shows a secret-shaped value, and it must not be logged or persisted
  client-side beyond the dialog's own session.
- A **Provisioning Tokens** tab/section: list (name, branch, expiry, uses/max, status),
  revoke action with confirmation.
- Row actions on a `pending_approval` device: **Approve** (`Dialog` — pick an existing
  station via `Select`, or a "create new station" sub-form with name/number, populated
  from `api.rpc.stations.$get`), same station-conflict 409 surfaced as a toast error.
- Row actions on an `approved` device: **Relink** (`Select` a different station),
  **Revoke** (destructive, `ConfirmationDialog`-style confirm step, matching
  `stations`' own delete-confirmation pattern).
- `toast.success`/`toast.error` on every mutation, matching the `Projects`/`Stations`
  page's inline-error convention.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Devices` entry to `BASE_NAV`
  (a `MonitorSmartphone`/`Cpu`-style `lucide-react` icon) and a `"/dashboard/devices":
  "Devices"` line to `TITLES`, alongside whatever `Stations` entry lands from that
  plan's own Phase 4 (exact line numbers unpinned here for the same reason `stations`'
  plan left `branches`' unpinned — land order isn't fixed).
- No module-registry feature-flag gate — same reasoning as `branches`/`stations` (core
  to every Chrono tenant, not optional).

### CRUD & Feedback Contract

| Entity | Action | Method | Auth | Permission | Notes |
|---|---|---|---|---|---|
| Device | Pair | `POST /api/v1/device/pair` | none (pairing code is the secret) | — | 400 on invalid/expired code |
| Device | Register/re-auth | `POST /api/v1/device/auth` | none (provisioning/device token is the secret) | — | Clone re-pairing resets to pending_approval |
| Device | Heartbeat | `POST /api/v1/device/heartbeat` | device-bearer + fingerprint | — | 401/403 per Pass 1 |
| Device | List | `GET /rpc/devices` | staff session | none (any tenant member) | paginated, filter by branch/status |
| Device | Approve | `POST /rpc/devices/:id/approve` | staff session | `device:approve` | 409 on station conflict |
| Device | Revoke | `POST /rpc/devices/:id/revoke` | staff session | `device:revoke` | idempotent-ish (revoking a revoked device is a no-op 200, not an error) |
| Device | Relink | `PATCH /rpc/devices/:id/link` | staff session | `device:manage` | 409 on station conflict |
| Provisioning token | Create | `POST /rpc/devices/provisioning-tokens` | staff session | `device:manage` | returns plaintext pairing code once |
| Provisioning token | List | `GET /rpc/devices/provisioning-tokens` | staff session | `device:manage` | never returns tokenHash |
| Provisioning token | Revoke | `POST /rpc/devices/provisioning-tokens/:id/revoke` | staff session | `device:manage` | blocks new redemptions only |

Feedback: `toast.success`/`toast.error` at the point of the API call
(`.ai/rules/ui.md`), no separate `<FormError>`.

Audit linkage: `recordStaffAudit` on every staff-triggered mutation (see Pass 1).
Device-originated writes are system traffic and are not audited via
`recordStaffAudit` (no staff actor) — if an audit trail of device-originated events is
wanted later, that's a separate `emitTenantEvent`-style concern, not `recordStaffAudit`,
since the actor shape is fundamentally different (see the top-of-file architecture
callout).

### Out of Scope (this plan)

- `device-commands` (remote lock/unlock/reboot/shutdown/screenshot/etc. dispatch) —
  confirmed genuinely separate, needs realtime transport that doesn't exist, needs
  `sessions`. A future module.
- The `modules/devices` (plural) `SUPER_ADMIN` cross-tenant platform-admin surface
  (list all tenants' devices, revoke, channel reassignment). No
  `PLATFORM_PERMISSION_STATEMENTS` resource exists for devices today — same deferral
  `branches`/`stations` made for their own `/rpc-admin` surfaces.
- `GET /status`, `POST /sync-events`, session-start, away-unlock, security-alert-report
  device-facing endpoints — entangled with `sessions`/`security-alerts`, neither built.
  See "Deliberately narrowed" above and "Forward references for `sessions`."
- PC-client behavioral settings (`autoUpdate`, `lockOnStartup`, min-charge
  amount/minutes) from oikos's `admin-station-client` — belongs with whichever module
  eventually owns PC-client configuration, not device pairing.
- The device-connectivity staleness sweep (oikos's `jobs/device-connectivity.ts` —
  bulk-flip devices to `connectivityStatus = 'offline'` after a missed-heartbeat
  window). Per this plan's own scoping instruction: agora DOES have two existing
  lightweight worker patterns (`startRetentionWorker()`'s `setInterval` loop wired in
  `apps/chrono-api/src/index.ts`, and the `agora/queue` named-queue pollers
  `startQueueWorker("email"|"sms"|"webhooks")` also wired there) that a future phase
  could follow — but standing one up is explicitly deferred out of this pass rather
  than added as a side effect of this plan. Until it lands, a device that drops offline
  keeps its last-known `connectivityStatus` in the dashboard, same known gap oikos's
  own job exists to close.
- The `apps/chrono-pc-client*` apps themselves — out of scope for the whole migration
  pass per `apps/chrono-api/AGENTS.md`; this plan only builds the server side of the
  protocol they will eventually speak.
- Module-registry (`modules.device`) feature-flag gating of the nav entry.
- A `device.*` webhook event — trivial follow-up, not required to ship.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/device/schema.ts` (new) — `chronoDeviceProvisioningToken`
  + `chronoDevice` tables (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export both, add
  `"ChronoDeviceProvisioningTokens"` and `"ChronoDevices"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/device/` and write `schema.ts` exactly as
   specified in Pass 2 (`chronoDeviceProvisioningToken` **before** `chronoDevice` — no
   FK between them, but keep the ordering intuitive/consistent with `station`'s own
   groups-before-stations convention). Import `chronoBranch` from `../branch/schema`
   and `chronoStation` from `../station/schema` directly (peer-module imports, not via
   `../../db/schema`).
2. In `apps/chrono-api/src/db/schema.ts`, add
   `export { chronoDeviceProvisioningToken, chronoDevice } from "../modules/device/schema";`
   and append `"ChronoDeviceProvisioningTokens"`, `"ChronoDevices"` to
   `APP_TENANT_TABLES`.
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_devices` (never
   `db:push`). Review the generated SQL: expect `CREATE TABLE
   "ChronoDeviceProvisioningTokens"` then `CREATE TABLE "ChronoDevices"` plus their
   indexes (including the two partial/conditional unique indexes), no destructive
   statements. Confirm the `ChronoStations` FK reference matches whatever `stations`'
   own Phase 1 already produced — if `stations` Phase 1 hasn't landed yet, this
   migration fails at `db:migrate` time until it does (the real dependency gate, same
   note `stations`' own plan made about `branches`).
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- `ChronoDeviceProvisioningTokens` and `ChronoDevices` exist with `FORCE ROW LEVEL
  SECURITY` on.
- Both names are present in `APP_TENANT_TABLES`.
- The partial unique index on `ChronoDevices (stationId) WHERE stationId IS NOT NULL
  AND status = 'approved'` exists and is enforced at the DB level (verify with a manual
  two-row insert attempt if in doubt, not just a read of the generated SQL).
- Migration file reviewed, no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, middleware, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/device/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/device/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `deviceStatusSchema`, `pairDeviceSchema`, `authDeviceSchema`,
   `heartbeatSchema`, `createProvisioningTokenSchema`, `approveDeviceSchema`,
   `relinkDeviceSchema`, `deviceListQuerySchema`, and their `z.infer` types exactly as
   specified in Pass 2.
2. No changes to `packages/agora/src/contracts` — per `business-app.md`, contracts stay
   local unless a second business app needs them.

**Acceptance criteria**

- All types compile and are importable from `../modules/device/contracts`.
- `approveDeviceSchema` accepts either `{ stationId }` or `{ newStationName,
  newStationNumber }` (both optional at the Zod layer — the route enforces "exactly one
  path chosen," since that's a cross-field rule Zod alone shouldn't own here given the
  DB-dependent station lookup either way).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** middleware, routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/device/contracts.ts`.

---

## Phase 3 — Device-auth middleware + device-facing routes

**This phase implements Open Question 1's design. Do not start it until that design is
confirmed with the developer** — it is the part of this plan most likely to need a
revision before code is written, and revising it after Phase 3-6 are built on top would
cost far more than a five-minute read now.

**Files to update**

- `apps/chrono-api/src/modules/device/device-auth-middleware.ts` (new) —
  `requireDeviceBearerAuth()` (Pass 2).
- `apps/chrono-api/src/modules/device/routes.ts` (new) — `deviceAuthRoutes()` factory
  (`/pair`, `/auth`, `/heartbeat`).
- `apps/chrono-api/src/app.ts` — `.route("/api/v1/device", deviceAuthRoutes())`,
  mounted alongside `/billing/webhook`/`/public/*`, **not** inside `/rpc` or `apiV1`.

**Step-by-step tasks**

1. Write `device-auth-middleware.ts`: parse `Authorization: Bearer` +
   `X-Device-Fingerprint`, hash-lookup via `withAdmin` against `ChronoDevices.tokenHash`
   (reusing `hashApiKey`/`verifyApiKey` from `agora/server`), fingerprint match
   required, 401/403 per Pass 1's failure cases, `c.set("device", ...)`.
2. Write `routes.ts`'s `POST /pair`: cross-tenant `withAdmin` lookup on
   `ChronoDeviceProvisioningTokens` by `pairingCode` + active + unexpired; mint +
   store a hashed provisioning token via `withTenant(row.tenantId, ...)`; return the
   raw token once.
3. Write `POST /auth`: cross-tenant `withAdmin` lookup on both
   `ChronoDeviceProvisioningTokens.tokenHash` and `ChronoDevices.tokenHash`; the three
   branches from Pass 2 (new registration / clone re-pairing / idempotent re-auth), all
   writes inside `withTenant`.
4. Write `POST /heartbeat`: `requireDeviceBearerAuth()`, `zValidator("json",
   heartbeatSchema)`, `withTenant(device.tenantId, ...)` update, minimal response.
5. Mount in `app.ts` per Pass 2.

**Acceptance criteria**

- `POST /api/v1/device/pair` with a valid code returns a provisioning token; with an
  invalid/expired code returns 400 with an identical message either way.
- `POST /api/v1/device/auth` with a fresh provisioning token + new fingerprint creates
  a `pending_approval` `ChronoDevices` row and returns a device token.
- `POST /api/v1/device/auth` replayed with the SAME provisioning token but a
  DIFFERENT fingerprint does not silently overwrite the first device's row — it
  registers as a distinct pending device (or, if a device row exists for that exact
  provisioning-token+different-fingerprint combination already, resets it to
  `pending_approval` per the clone-detection branch).
- `POST /api/v1/device/heartbeat` with a valid bearer token + matching fingerprint on
  an `approved` device updates `lastSeenAt`/`connectivityStatus` and returns 200; with a
  mismatched fingerprint (same token) returns 401; on a `pending_approval` or `revoked`
  device returns 403.
- A device from tenant A's token/fingerprint can never authenticate rows belonging to
  tenant B (prove this explicitly — not just by code review — as part of this phase's
  own manual verification, since it is the crux of this whole module's tenant-isolation
  guarantee and `rls:proof` alone does not exercise this cross-tenant lookup path).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- Manual verification of the cross-tenant device-auth isolation scenario above (no
  existing automated harness exercises a non-session, non-API-key actor yet — note this
  gap; Phase 6's e2e spec is browser/staff-session-only per
  `.ai/rules/e2e-testing.md`'s own tooling, so this manual step is not optional).

**Out of scope:** staff-facing routes (Phase 4), UI (Phase 5).

**Execution start point:** confirm Open Question 1 with the developer, then create
`apps/chrono-api/src/modules/device/device-auth-middleware.ts`.

---

## Phase 4 — Staff-facing routes + permission gates

**Files to update**

- `apps/chrono-api/src/auth/permissions.ts` — add `device: ["approve", "revoke",
  "manage"]` to `CHRONO_PERMISSION_STATEMENTS` and to `CHRONO_ADMIN_GRANTS` (per the
  per-app permission extension seam — see "Permission vocabulary" above; resolve Open
  Question 2 first). Never `packages/agora/src/auth/permissions.ts` — that precedent was
  retired, same correction the `reservations` plan already made.
- `apps/chrono-api/src/modules/device/routes.ts` — add `staffDeviceRoutes()` factory
  alongside the device-facing one from Phase 3 (same file, two exported factories, per
  Pass 2's file layout).
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/devices", staffDeviceRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `device` gate cases (staff denied
  `approve`/`revoke`/`manage` under this plan's default; admin/owner allowed),
  mirroring the existing `project`/`branch`/`station`/`reservation` cases, using the
  Chrono typed wrapper (`hasPermission` from
  `apps/chrono-api/src/auth/require-permission.ts`), not `agora/auth` directly.

**Step-by-step tasks**

1. Edit `apps/chrono-api/src/auth/permissions.ts` per Pass 2's Open Question 2
   resolution.
2. Write `staffDeviceRoutes()`: `GET /` (ungated, paginated), `POST
   /provisioning-tokens` / `GET /provisioning-tokens` / `POST
   /provisioning-tokens/:id/revoke`, `POST /:id/approve`, `POST /:id/revoke`, `PATCH
   /:id/link` — exactly as specified in Pass 2's Routes section, including the
   station-ownership + conflict checks. Follow the exact structure of the
   `project`/`station` blocks in `apps/chrono-api/src/routes/rpc.ts` (import style,
   `HttpError`, pagination meta shape).
3. Compose into `apps/chrono-api/src/routes/rpc.ts` via `.route("/devices",
   staffDeviceRoutes())`.
4. Add `device` cases to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { device: ["approve"] }) === false`,
   `hasPermission("staff", { device: ["revoke"] }) === false`,
   `hasPermission("staff", { device: ["manage"] }) === false`,
   `hasPermission("admin", { device: ["approve"] }) === true` (and `revoke`/`manage`),
   `hasPermission("owner", { device: ["approve"] }) === true` (and `revoke`/`manage`) —
   adjust to match whichever resolution Open Question 2 lands on.

**Acceptance criteria**

- `GET /rpc/devices` returns `{ items, meta }` for any authenticated tenant member.
- `POST /rpc/devices/:id/approve` as staff → 403 (or 200, if Open Question 2 is
  resolved the other way); as admin/owner → 200.
- Approving onto a station that already has an approved device → 409.
- `POST /rpc/devices/:id/revoke`/`PATCH /rpc/devices/:id/link` on another tenant's
  device id → 404.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `device` cases.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out of scope:** UI (Phase 5), e2e browser spec (Phase 6).

**Execution start point:** edit `apps/chrono-api/src/auth/permissions.ts` first (the
routes file imports `requirePermission` against the new resource).

---

## Phase 5 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/devices/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected; `Dialog`/`Select`/`Input`/`Label`/`Badge` already exist).

**Step-by-step tasks**

1. Build `page.tsx` mirroring `apps/chrono-web/src/app/dashboard/stations/page.tsx`'s
   branch-filtered pattern, extended with a status filter: `useListQuery(["branchId",
   "status"])`, `api.rpc.devices.$get/...` typed calls, `DataTable`/`DataTableGrid` +
   `DataTableToolbar` + `DataTablePagination`.
2. Add the **Generate Pairing Code** dialog + one-time plaintext-code display (Pass 2).
3. Add the **Provisioning Tokens** list/revoke section.
4. Add row actions: **Approve** (station-select-or-create dialog), **Relink**, **Revoke**
   (confirmation dialog) — `agora/ui` primitives only (`.ai/rules/component-first-ui.md`).
5. Wire `toast.success`/`toast.error` on every mutation.
6. Add `{ type: "item", name: "Devices", href: "/devices", icon: <pick an appropriate
   lucide-react icon> }` to `BASE_NAV`, and `"/dashboard/devices": "Devices"` to
   `TITLES`.

**Acceptance criteria**

- `/dashboard/devices` renders the list, branch/status filters + search/sort/paginate/
  view-toggle all update the URL.
- Generate-pairing-code, approve, relink, revoke all submit successfully and the list
  refreshes.
- A staff-role session sees the list but gets a toast error attempting approve/revoke
  (or succeeds, if Open Question 2 is resolved the other way) — matches whatever Phase 4
  landed on.
- No raw HTML chrome introduced in `apps/chrono-web`.

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 6), any device-operational UI (connectivity dot detail,
remote commands — `device-commands`, deferred).

**Execution start point:** create `apps/chrono-web/src/app/dashboard/devices/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/devices/devices.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring `apps/chrono-web/e2e/tests/stations/stations.spec.ts`'s
   structure, covering three cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant, create a branch, navigate to
     `/dashboard/devices`, generate a pairing code. Since there is no real PC-client
     harness in this test suite, simulate the device side with a direct `fetch`/`request`
     call to `POST /api/v1/device/pair` then `POST /api/v1/device/auth` from the spec
     itself (Playwright's `request` fixture, not the browser page) to produce a
     `pending_approval` device row, THEN drive the rest through the UI: the pending
     device appears, approve it (assign to a new station), confirm it moves to
     Approved, revoke it, confirm it moves to Revoked.
   - **Role gate**: owner generates a pairing code and pairs a device (same simulated
     device-side calls), invites a staff teammate, staff can view the list but
     attempting approve/revoke surfaces a 403-driven toast and the row is unchanged
     (or succeeds, matching whichever way Open Question 2 was resolved).
   - **Tenant isolation**: tenant A pairs a device (simulated calls); tenant B's device
     list never shows it, and — critically for THIS module specifically — a device
     paired under tenant A's provisioning token cannot authenticate a heartbeat that
     touches tenant B's data even if the spec deliberately tries to force it (this is
     the browser-suite's version of Phase 3's manual verification step; it exercises
     the same property through the actual HTTP surface instead of ad hoc calls).
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for slugs/emails/names/
   pairing-token names, per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config).
- No `.env` present in `apps/chrono-api` while running.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/devices/devices.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage (no platform-admin routes exist for
devices in this pass); a real PC-client-driven test (no PC-client app is built in this
migration pass).

**Execution start point:** create `apps/chrono-web/e2e/tests/devices/devices.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/devices/` to
`.ai/plans/chrono/archive/devices/` once all six phases are verified and committed
separately. Update `.ai/handover/chrono-migration.md`'s status table row for `devices`
to reflect implementation progress as phases land. Flag to whoever plans `sessions`
next that this module's device-facing endpoints (`/heartbeat` especially) are
intentionally minimal and will need extending once `ChronoSessions` exists — see
"Forward references for `sessions`" in Pass 2.
