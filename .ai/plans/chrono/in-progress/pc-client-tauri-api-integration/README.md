# Chrono — `pc-client-tauri-api-integration`

**Sessions:**
- Planning: Claude Code (main session)
- Audit: Claude Code (plan-auditor agent a9ce88c3794cf82f2) — approved with conditions, folded in
- Implementation: Claude Code (subagent, worktree `.ai/worktree/pc-client-tauri-api-integration`, branch `feature/pc-client-tauri-api-integration`) — Phase 1 in progress

## What this is

Bring `apps/chrono-pc-client-tauri` (a mature, largely-complete Rust/Tauri kiosk
client — code lives at `C:\Users\ronni\project\izur\oikos\apps\chrono-pc-client-tauri`,
a sibling `oikos` workspace, **not** this repo) online against **this repo's**
`apps/chrono-api` — the from-scratch Agora-foundation reimplementation of Chrono. The
Tauri client was built against oikos's old API (Express + Socket.IO); `apps/chrono-api`
here is a different backend (Hono + `agora/realtime`, forced RLS, bearer-token device
auth) that explicitly deferred PC-client support: `apps/chrono-api/AGENTS.md:122-125`
states pc-client apps are "out of scope for this migration pass" but that "the API
still needs to support device pairing/bearer-auth (stations depend on it)."

Device pairing/bearer-auth **is** already landed here (`.ai/plans/chrono/archive/devices/`)
and is structurally close to what the Tauri client expects. Two real capability gaps
remain, both previously flagged and deferred:

- **Remote command dispatch** (lock/unlock/reboot/force-logout) — `.ai/plans/chrono/blocked/admin-station-client/README.md`
  confirms this was blocked specifically because "no PC-client exists" to receive
  commands. One now does. This plan is what unblocks it.
- **Device-facing session/wallet status** — `apps/chrono-api/src/modules/device/routes.ts`'s
  `/heartbeat` handler explicitly returns "no session/pricing/reservation payload...
  that's `sessions`' concern once it exists" (routes.ts:~730). It still doesn't exist.
  The Tauri client's whole session-state UI (`Available`/`Active`/`LowTime`/`Expired`/
  `Locked` states) has nothing real to read today.

**This is a cross-repo plan.** Server-side phases (schema/routes/realtime) land in
*this* repo (`apps/chrono-api`, `apps/chrono-web` if an admin surface is needed).
Client-side phases (Rust/TS changes) land in the `oikos` workspace's
`apps/chrono-pc-client-tauri` — out of this repo's git history, tracked here only as
the plan of record since that's where the developer asked for it. Each phase says
explicitly which repo it touches.

## Improve, don't replicate

Per explicit developer instruction: this plan does **not** try to make the Tauri
client match oikos's old API 1:1. Two places where "port it as-is" would actively
regress:

1. **Realtime transport.** The Tauri client's `src-tauri/src/realtime.rs` speaks
   **Socket.IO** (`rust_socketio` crate) against oikos's old `apps/chrono-api/src/realtime/socket.ts`.
   This repo's device mount (`apps/chrono-api/src/modules/device/realtime-actor.ts`,
   `GET /api/v1/device/ws`) is `agora/realtime` — a plain authenticated WebSocket with
   its own JSON frame/scope protocol, not Socket.IO. These are wire-incompatible
   protocols, not a config difference. Bridging them with a Socket.IO shim on the
   server would mean running two realtime stacks side by side, permanently, for one
   client type — the wrong trade. **Decision: replace `rust_socketio` with a plain
   WebSocket client (e.g. `tokio-tungstenite`, already implied by the `tauri` async
   runtime) speaking `agora/realtime`'s actual protocol.** This is a Tauri-client-side
   change (oikos repo), covered in Phase 2.
2. **Command dispatch shape.** oikos's design (per the Tauri client's own code
   comments referencing `emitDeviceCommand`) assumed the server can push a command
   over an always-open socket and the device ack's it inline. That's compatible with
   `agora/realtime`'s actual push model (see Phase 3), so this part *can* carry over
   conceptually — but the **schema and route are being designed fresh** against this
   repo's actual `chronoDevice` table and permission vocabulary (`device` resource,
   `.ai/rules/rbac.md`), not copied from an oikos `DeviceCommand` table this repo has
   never seen the schema for.

Everything else the Tauri client already does well and should NOT change: hardware
fingerprinting (`identity.rs`), DPAPI at-rest secret storage (`secure.rs`), the
separate `chrono-guard` Windows-service lockdown enforcer, the session-state UI
skeleton. Those are kept; only their data source changes.

## Pass 1 — Workflow Analysis

- **Who uses this**: the physical kiosk PC itself (machine identity, no human
  session) — pairing, heartbeat, realtime command/status. Indirectly, the customer
  sitting at that PC (session start/end, time remaining, low-balance warning) and the
  venue's tenant `admin`/`owner` (approve device, eventually issue lock/reboot/
  force-logout commands via `apps/chrono-web`).
- **End-to-end workflow enabled**: a fresh Windows PC runs the Tauri client → staff
  generates a pairing code in `apps/chrono-web` (`.ai/plans/chrono/archive/devices/`,
  already shipped) → client calls `/pair` then `/auth`, gets bearer token, sits in
  `pending_approval` → staff approves → client heartbeats + opens the realtime socket
  → a customer authenticates on the kiosk (QR or email/password) → client shows
  live session/time/balance state, driven by real reads + realtime pushes → staff (or
  eventually the venue admin, once command-dispatch lands) can remotely lock/reboot/
  force-logout the station.
- **Failure cases**: device revoked mid-connection (already handled server-side —
  `revalidateEveryMs` re-check, `closeConnections` on revoke); PC offline (heartbeat
  gap → `connectivityStatus: offline`, already covered); command sent to an offline
  device (must not silently vanish — needs a queued/expired state, not just fire-and-
  forget); session ends/wallet drains while a command is in flight; wrong-tenant/
  wrong-branch device data leak (must go through `withTenant`, same as every other
  module — no new leak surface this plan introduces).
- **Notifications/audit**: command issue + result should audit (`recordAudit`/
  `auditEvent` pattern, mirroring other sensitive Chrono mutations); realtime pushes
  for session lifecycle events (started/ending-soon/ended) and wallet-low give the
  kiosk UI what it needs without polling.

## Pass 2 — Technical Planning

### What already exists and is reusable as-is

- Pairing + bearer auth: `POST /api/v1/device/pair`, `POST /api/v1/device/auth`,
  `POST /api/v1/device/heartbeat`, `POST /api/v1/device/security-alert`
  (`apps/chrono-api/src/modules/device/routes.ts`) — device-bearer-gated via
  `requireDeviceBearerAuth()` / `resolveDeviceAuthContext`
  (`device-auth-middleware.ts`), never trusts client-supplied `deviceId`/`tenantId`.
- Device approve/revoke/link: staff-facing `/rpc` routes, already shipped, already
  has a web UI at `apps/chrono-web/src/app/dashboard/devices/page.tsx`.
- Device realtime mount: `GET /api/v1/device/ws`
  (`apps/chrono-api/src/modules/device/realtime-actor.ts`), `agora/realtime`-based,
  device-bearer-authenticated, scope pattern `device:<deviceId>`
  (`apps/chrono-api/src/modules/realtime/scope-validators.ts`,
  `validateChronoDeviceScopes`). `onFrame` today only ever filters — it drops a frame
  naming a different device's `deviceId`, but processes/stores nothing even for a
  self-referential frame; "no inbound frame TYPE is defined yet (remote commands/acks
  are deferred)" (realtime-actor.ts comment) — this is the exact seam Phase 3 fills in.
- `device` permission resource already registered
  (`apps/chrono-api/src/auth/permissions.ts`, via `registerAppPermissions()`).

### What's genuinely new work

1. Read `packages/agora/src/events/realtime/` (protocol/frame shape, connect
   handshake, ping/pong, how a server-side handler pushes a frame to one actor vs
   broadcasts to a tenant) before writing either the command-dispatch server code or
   the Tauri WS client — this repo's realtime protocol has not yet been read in this
   plan and must be before Phase 2/3 are made implementation-ready.
2. `ChronoDeviceCommands` table (new) — command queue: `id, tenantId, deviceId,
   type (lock|unlock|reboot|force_logout), status (pending|delivered|acked|expired),
   issuedByUserId, issuedAt, deliveredAt, ackedAt, expiresAt, result (jsonb, nullable)`.
   Tenant-scoped, RLS-forced, added to `APP_TENANT_TABLES`.
3. `POST /rpc/devices/:id/commands` — `device:manage`-gated (existing resource,
   already admin+-only per RBAC rules), writes a `pending` command row, pushes it
   over the device's open realtime connection if online (best-effort — a queued row
   is the source of truth, the push is just latency-avoidance), audits the write.
4. Device WS `onFrame` gains one real inbound frame type: `{ type: "command-ack",
   commandId, result }` — validated to reference a command belonging to the
   connecting device's own `actor.actorKey`, exactly like the existing
   self-referential `deviceId` check.
5. Device-facing session/wallet status: new device-bearer-gated read route(s) under
   `/api/v1/device` (exact shape TBD in Phase 4 — likely `GET /session/active` +
   `GET /wallet/balance`, mirroring `sessionPortalRoutes()`'s shape but keyed off the
   device's own `stationId`, not a `tenantMember`), plus realtime push events on
   session start/end/low-time and wallet-low, sourced from `apps/chrono-api/src/modules/session/service.ts`
   and `apps/chrono-api/src/modules/wallet/`.
6. Kiosk login (QR / email+password) that **starts a session tied to the device's
   station** — not yet confirmed to exist anywhere in `apps/chrono-api`. Needs its own
   read-the-actual-session-module pass before Phase 5 can be made concrete; flagged as
   an open question below, not assumed.

**Tenant-isolation / RBAC constraints, locked in now per plan-audit, before Phase 3/4
leave DRAFT:**
- Phase 3 command-ack validation must scope the command lookup by both `tenantId`
  and `deviceId` via `withTenant(actor.tenantId, ...)`, not just filter by `deviceId`
  client-side — mirroring `requireOwnDevice`'s existing pattern (`routes.ts:112-122`),
  so a forged `commandId` can't be acked cross-tenant even if the realtime actor-key
  check is somehow bypassed.
- Phase 3 push-on-issue (server to a single connected device) must target the
  connection by the `{ tenantId, actorKey }` tuple together — the same pair
  `closeConnections()` already requires (`routes.ts:462`) — confirmed once the
  Phase-2 prerequisite protocol read establishes the actual push API shape.
- Phase 4 device-facing reads must stay scoped by the device's own `stationId`, not
  just `tenantId` — a compromised single kiosk must never be able to read another
  customer's session/wallet data tenant-wide. This must be an explicit, testable
  Phase 4 acceptance criterion, not just prose.
- `ChronoDeviceCommands` (Phase 3) must follow `.ai/rules/database.md` exactly:
  `tenantId` referencing `organization.id` `onDelete: cascade` plus a `*_tenant_idx`
  index, added to `APP_TENANT_TABLES`, migrated via `db:generate --name` +
  `db:migrate` (never `db:push`), and `rls:proof` re-run before the phase is done.

### Divergence from the Tauri client's current assumptions (must change client-side)

- Drop `rust_socketio`; use a plain WS client speaking `agora/realtime`'s protocol
  (Phase 2, oikos repo).
- `src-tauri/src/http.rs` / `src/features/api/pc-client-api.ts` request/response
  shapes must be checked field-by-field against this repo's actual `pairDeviceSchema`/
  `authDeviceSchema`/`heartbeatSchema` (`apps/chrono-api/src/modules/device/contracts.ts`,
  not yet read in this pass — Phase 1 task) rather than assumed compatible because the
  endpoint names look similar.
- Base URL convention: client auto-appends `/api/v1/device` if missing
  (`client-config.ts`) — confirm this repo's actual mount path matches
  (`apps/chrono-api/src/app.ts`'s `.route("/api/v1/device", ...)` — consistent per
  the routes.ts comment above, but verify the `app.ts` mount line directly in Phase 1).

## Phases

### Phase 1 — Contract audit: REST device endpoints (DRAFT, this repo + read-only in oikos)

Verify field-for-field compatibility between the Tauri client's existing HTTP calls
and this repo's real `/api/v1/device/*` contracts; fix any mismatches server-side
only if this repo's contract is the one that's wrong (e.g. missing a field the client
legitimately needs) — otherwise the client adapts, since this repo's API is the
target of record going forward.

- **Files to update (this repo)**: `apps/chrono-api/src/modules/device/contracts.ts`,
  `routes.ts` (only if a genuine contract gap is found, e.g. `/pair` or `/auth`
  response missing a field the kiosk needs at first boot).
- **Files to read (oikos, no edits yet)**: `src-tauri/src/http.rs`,
  `src/config/client-config.ts`, `src/features/api/pc-client-api.ts`.
- **Step-by-step tasks**:
  1. Diff `pairDeviceSchema`/`authDeviceSchema`/`heartbeatSchema` field-by-field
     against what `http.rs` sends/expects. Known finding to confirm/resolve:
     `http.rs`'s `try_refresh()` POSTs `/auth` with `{ tokenHash, fingerprintV1,
     hostname }`, but this repo's `authDeviceSchema` requires `{ fingerprint,
     hostname, provisioningToken }` — field names don't line up at all. This is a
     client bug (client adapts), not a server gap, per the default above — confirm
     and record it as the first diff-table row.
  2. Confirm the `/api/v1/device` mount path in `apps/chrono-api/src/app.ts` matches
     `client-config.ts`'s auto-append convention.
  3. Confirm whether `client-config.ts::API_BASE_URL` is still read anywhere live in
     the webview, given `http.rs`'s own doc comment says the Rust core holds the
     access token/cookie jar and owns all real HTTP calls — flag as stale duplication
     to remove in Phase 1's diff table if so, not a live contract surface.
  4. Document every mismatch found (client bug vs. genuine server gap) in this plan's
     "Findings" section (append after this audit runs) before writing any code.
- **Acceptance criteria**: a written diff table of every device REST endpoint the
  client calls vs. what this repo serves, with a fix owner (client or server) per row,
  including the `/auth` field-name mismatch above.
- **Verification commands**: none required for the read/diff itself. If a server-side
  contract fix is made (per "Files to update" below), `pnpm typecheck` must pass
  before this phase is closed — a real code edit never ships with zero verification.
- **Out of scope**: no code changes beyond a genuine, documented server-side contract
  gap.
- **Execution start point**: read `apps/chrono-api/src/modules/device/contracts.ts`
  in full, then `oikos/apps/chrono-pc-client-tauri/src-tauri/src/http.rs` in full.

### Phase 2 — Realtime transport migration (oikos repo, Rust)

Replace the Socket.IO client with a plain WebSocket client speaking this repo's
`agora/realtime` protocol.

- **Prerequisite**: read `packages/agora/src/events/realtime/` (this repo) for the
  exact handshake/frame/scope-subscription/ping-pong shape before writing Rust code.
- **Files to update (oikos)**: `src-tauri/src/realtime.rs` (rewrite transport,
  keep the existing `"device-command"` handling shape as the target inbound event —
  now delivered as a JSON frame over plain WS, not a Socket.IO event), `Cargo.toml`
  (drop `rust_socketio`, add a WS client crate).
- **Status**: DRAFT — implementation-ready only after the `agora/realtime` protocol
  read above; this entry is a placeholder until that read happens.

### Phase 3 — Device command dispatch (this repo)

- **Files to update**: `apps/chrono-api/src/db/schema.ts` (or a
  `modules/device/schema.ts` addition) + migration for `ChronoDeviceCommands`;
  `APP_TENANT_TABLES`; `apps/chrono-api/src/modules/device/contracts.ts` (command
  request/response schemas); `apps/chrono-api/src/modules/device/routes.ts` (new
  `POST /rpc/devices/:id/commands` — note this is the STAFF-facing `/rpc` mount, not
  `deviceAuthRoutes()`); `apps/chrono-api/src/modules/device/realtime-actor.ts`
  (`onFrame` gains `command-ack` handling + a push-on-issue path).
- **Status**: DRAFT — needs the Phase-2 prerequisite protocol read to know how a
  server-side handler pushes an unsolicited frame to one connected actor.

### Phase 4 — Device-facing session & wallet status (this repo)

- **Files to update**: new device-bearer-gated routes under `deviceAuthRoutes()` (or
  a sibling mount) reading `apps/chrono-api/src/modules/session/*` and
  `apps/chrono-api/src/modules/wallet/*`; realtime push on session
  start/end/low-time/wallet-low from `session/service.ts`.
- **Status**: DRAFT — needs a dedicated read of `session/service.ts` +
  `wallet/` schema/routes before the exact endpoint shape can be pinned down.

### Phase 5 — Kiosk login → session start (this repo + oikos)

- **Open question, not yet resolved**: does any existing route let a device (not a
  `tenantMember` portal session) start a session tied to its own station via
  QR/email+password entered on the kiosk itself? Not found in this pass. Needs its
  own Pass 1/Pass 2 once Phases 1–4 are further along — do not start this phase
  concretely until that's answered.

### Phase 6 — E2E + verification

- `pnpm typecheck`, `pnpm --filter @agora/api rls:proof` after any schema/RLS change
  (Phase 3), a new `apps/chrono-web` e2e spec if an admin command-dispatch UI is
  added, and a manual Tauri-client-against-local-`chrono-api` smoke test (pairing →
  approve → heartbeat → realtime connect → command round-trip) since the client half
  lives outside this repo's automated test surface.

## Out of Scope

- `apps/chrono-mobile`, `apps/chrono-docs`, `chrono-pc-client` (non-Tauri),
  `chrono-pc-client-service` — untouched by this plan.
- Release/update-manifest publishing tooling (`.ai/plans/chrono/blocked/public-releases/`)
  — separately blocked, not this plan's concern.
- Redesigning `chrono-guard` (the separate Windows lockdown service) — out of scope;
  it doesn't talk to `chrono-api` directly per the Tauri client's own architecture.
- A platform-admin cross-tenant device rollup (`admin-station-client`'s own "Surface"
  discussion already deferred this as a separate, additive follow-up) — not this plan.

## Open Questions

1. Kiosk login → session start (Phase 5) — no existing route found; needs dedicated
   research before it can be planned concretely.
2. Command delivery to an offline device: queue-and-wait-for-next-heartbeat/reconnect,
   or expire after N minutes? Needs a decision before Phase 3's route logic is final.
3. Should command-dispatch get a tenant-admin web UI in this pass, or REST-only for
   now (Tauri client is the only consumer initially)? Affects whether Phase 3 also
   touches `apps/chrono-web`.

## Phase 1 Findings

Audit method: read `apps/chrono-api/src/modules/device/{contracts.ts,routes.ts}` and
`apps/chrono-api/src/app.ts`'s mount lines in full (this repo); read
`oikos/apps/chrono-pc-client-tauri/src-tauri/src/http.rs`,
`src/config/client-config.ts`, `src/features/api/pc-client-api.ts` in full, then
dispatched a read-only Explore pass into the oikos repo to find the actual Rust IPC
command bodies (`src-tauri/src/commands/api.rs`) and the TS request/response contract
types (`src/features/api/contract.ts`), since `pc-client-api.ts` itself is a thin facade
over `native.pcClient.*` Tauri IPC calls, not the place the wire payload is built.

**Conclusion: every mismatch found is a client-side bug — the client must adapt to this
repo's actual contract. No genuine server-side gap was found; no code was changed in
this repo for Phase 1.**

### Diff table

| Endpoint | Client request (oikos, as coded) | This repo's actual contract | Mismatch | Fix owner |
|---|---|---|---|---|
| `POST /pair` | `PairRequest`: `{ pairingCode: string }` (`contract.ts`) | `pairDeviceSchema`: `{ pairingCode: string.min(1).max(32) }` | Request body matches. **Response mismatch**: this repo returns `{ provisioningToken, tenantId, branchId }`; `pair_device` (`commands/api.rs`) reads `data.tokenHash` and stores it as `device_token` — that field doesn't exist in the response, so pairing would store `undefined`/nothing and break the very next `/auth` call. | Client (read `provisioningToken`, not `tokenHash`) |
| `POST /auth` (normal call, via `auth_device` IPC command) | `AuthDeviceRequest`: `{ fingerprintV1, hostname?, tokenHash }` | `authDeviceSchema`: `{ fingerprint, hostname?, provisioningToken }` | Field names don't line up at all: `fingerprintV1`→`fingerprint`, `tokenHash`→`provisioningToken`. **Confirms the known finding.** Also, `auth_device` reads `data.accessToken` (and strips `accessTokenExpiresIn`) from the response; this repo's `/auth` returns `{ deviceToken, status, minted }` — no `accessToken`, no expiry, and no refresh-token concept at all. This repo mints one long-lived bearer `deviceToken` used directly as `Authorization: Bearer <deviceToken>` on every subsequent call (see `requireDeviceBearerAuth`/`heartbeat`); it does not distinguish a short-lived access token from a longer-lived refresh credential. | Client — both the field names AND the client's whole access-token/refresh mental model need to change (flagged for Phase 2, not just a rename) |
| `POST /auth` (401 refresh path, `http.rs::try_refresh`) | `{ tokenHash, fingerprintV1, hostname }` | same `authDeviceSchema` as above | Same two field-name mismatches as the normal call — this is the pre-confirmed finding from the plan. Additionally: this repo's `/auth` for an **already-known device+fingerprint** (idempotent re-auth) returns `{ status, minted: false }` with **no token in the response at all** (`routes.ts:704-707`) — it never issues a "fresh" credential on a routine re-check the way `try_refresh` assumes. The client's periodic-refresh model doesn't map onto this repo's mint-once bearer-token design. | Client (rename fields; the refresh-on-401 pattern itself needs redesign once Phase 2 picks a device-auth story — flag, don't silently rename and call it fixed) |
| `POST /heartbeat` | `HeartbeatRequest['payload']`: `{ lockState?, runtimeStatus?, activeSessionId?, lastTrustedServerAt?, localTime?, uptime?, queuedEventCount?, serviceHealth?, uiHealth? }` | `heartbeatSchema`: `{ lockState?, runtimeStatus?, clientVersion?, osVersion?, uptimeSeconds?, }` | `uptime`→`uptimeSeconds` (name mismatch, silently dropped by Zod's default-strip behavior — heartbeat would always upload `uptimeSeconds: undefined`); `activeSessionId`/`lastTrustedServerAt`/`localTime`/`queuedEventCount`/`serviceHealth`/`uiHealth` have no server-side field and are silently dropped (not an error, since `heartbeatSchema` isn't `.strict()` — but silently lossy); the client never sends `clientVersion`/`osVersion`, which this repo's device list UI presumably wants to show. | Client (rename `uptime`→`uptimeSeconds`; add `clientVersion`/`osVersion`; drop or find a future home for the other now-unsupported fields — none is a Phase-1-blocking gap) |
| `POST /security-alert` (reported by client as `POST /alerts/report`) | `report_security_alert` posts to path `"/alerts/report"` (`commands/api.rs`); body `ReportSecurityAlertRequest['payload']`: `{ type: string, severity: 'LOW'\|'MEDIUM'\|'HIGH'\|'CRITICAL', message, metadata?, timestamp }` | Route is mounted at `POST /security-alert` (`routes.ts`), not `/alerts/report` — a client call to `/alerts/report` 404s outright. Body schema `deviceReportSecurityAlertSchema`: `{ severity: "low"\|"medium"\|"high"\|"critical", type: <fixed enum: device_tamper\|unauthorized_access\|unexpected_shutdown\|chassis_open\|camera_flagged\|customer_dispute\|theft_suspected\|other>, message, metadata? }` | **Path mismatch** (`/alerts/report` vs `/security-alert` — highest-severity finding in this table, this call fails outright today); `severity` casing (`'LOW'` vs `"low"`); `type` is free-text on the client vs a fixed lowercase-snake_case enum server-side, so the client must map its own alert-type strings onto this repo's taxonomy (or use `"other"`); `timestamp` field is accepted-and-ignored server-side (harmless). | Client (fix the path, lowercase severity, map/constrain `type` to the server enum) |
| Mount path / base URL convention | `client-config.ts`/`http.rs::api_base_url()` both auto-append `/api/v1/device` to `VITE_API_BASE_URL` if not already present | `app.ts` mounts `deviceAuthRoutes()` (and the realtime/app-usage device routers) at `.route("/api/v1/device", ...)` | **No mismatch** — the convention matches; once the env var points at this repo's API origin, the auto-appended path resolves correctly. | N/A |

### `CLIENT_CONFIG.API_BASE_URL` — live or dead?

Not read anywhere in the TS/React layer to make a real HTTP call. All real `/pair`,
`/auth`, `/heartbeat`, `/security-alert` traffic goes through `native.pcClient.*` → Tauri
IPC → the Rust `HttpGateway` in `src-tauri/src/http.rs`, which resolves its **own**,
independently-configured `api_base_url()` (same env var, `VITE_API_BASE_URL`, read
directly via `std::env::var` in Rust — not through the TS constant at all). The only two
live TS-side consumers of `CLIENT_CONFIG.API_BASE_URL` are: (1) `src/lib/realtime.ts`,
which derives just the WebSocket **origin** (`new URL(...).origin`) to hand to the Rust
realtime initializer — no HTTP request is made from TS here either; and (2)
`src/features/diagnostics/Diagnostics.tsx`, which renders it as plain display text in a
diagnostics panel. **Finding: `CLIENT_CONFIG.API_BASE_URL` is effectively dead as a
request-construction surface** (referenced, but never drives an actual `fetch`), though
not literally unreferenced — flag for cleanup consideration in Phase 2, not a blocker.

### Server-side change made in this repo

None. Every mismatch above is a client-repo fix. `pnpm typecheck` was not run for this
reason (no code changed).
