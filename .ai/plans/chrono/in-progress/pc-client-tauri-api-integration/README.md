# Chrono — `pc-client-tauri-api-integration`

**Sessions:**
- Planning: Claude Code (main session)
- Audit: Claude Code (plan-auditor agent a9ce88c3794cf82f2) — approved with conditions, folded in
- Implementation: Claude Code (main session dispatching fresh subagents per phase,
  worktree `.ai/worktree/pc-client-tauri-api-integration`, branch
  `feature/pc-client-tauri-api-integration`) — Phases 1-4 DONE (Phase 2 in the
  Tauri client's own repo/branch, see below). Phase 5 still blocked on its open
  question; Phase 6 (e2e/manual smoke) not started.

**Phase status:**
- Phase 1 (contract audit) — DONE, no server changes needed (all client-side fixes).
- Phase 2 (Rust realtime transport) — DONE. Repo: `/Users/risurina/karta/karta-tenant`
  (not the stale Windows path this plan originally cited — corrected above). Branch
  `feature/agora-realtime-transport`, commit `edbff4b4`. `cargo check`/`build` clean.
- Phase 3 (device command dispatch) — DONE. This repo, worktree branch
  `feature/pc-client-tauri-api-integration`, commit `ac5c67ea`. `typecheck` +
  `rls:proof` (`pnpm --filter @agora/chrono-api rls:proof`, not `@agora/api`) both pass.
- Phase 4 (device session/wallet status) — DONE, commit `2b8092da`, plus a follow-up
  fix `c57e8799` (the wallet-low push originally fired inside the caller's open
  transaction rather than after commit — violated the same rule
  `publishSessionTransition` documents; refactored `applyWalletDelta` to return a
  signal and moved every call site's publish to after its own `withTenant` resolves).
  `typecheck` + `rls:proof` pass on both commits.
- Phase 5 (kiosk login → session start) — DONE, commit `b73545ae`. Research
  resolved the open question (no prior device-initiated session-start route existed);
  new `POST /api/v1/device/session/start` reuses `startSession()` and a newly
  exported `verifyMemberPassword` (`packages/agora/src/identity/member-auth/index.ts`
  — renamed from an internal `verifyPassword`, no behavior change, both existing call
  sites updated), gated by a new per-device `deviceSessionLoginLimiter` (20/15min)
  alongside the per-account check. `typecheck` + `rls:proof` pass.
- Phase 6 (e2e + verification) — NOT STARTED. Both branches (this repo's
  `feature/pc-client-tauri-api-integration`, pushed; the Tauri repo's
  `feature/agora-realtime-transport`, pushed) are up on their remotes but not merged.

**Not yet done, before this plan can close:** open PRs / merge both branches; add the
e2e spec for the new `/rpc/devices/:id/commands` + `/api/v1/device/{session,wallet,
session/start}` routes per `.ai/rules/e2e-testing.md` (not yet written — this is the
one hard gate `.ai/rules/e2e-testing.md` calls non-optional for a new tenant-scoped
feature); and run the manual pairing→approve→heartbeat→realtime→command-roundtrip
smoke test Phase 6 calls for (needs a running `pnpm dev` + a real Tauri build against
the new branch — cannot be done from a coordinating session alone).

**Correction**: the Tauri client repo is NOT at the Windows path this plan originally
cited. It is locally reachable at `/Users/risurina/karta/karta-tenant/apps/chrono-pc-client-tauri`
(same repo the root `AGENTS.md`/memory already flag as the correct local path for the
sibling `oikos` prior-art workspace) — every "oikos repo" reference below means that
path.

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

### Realtime protocol read (prerequisite, done)

Read `packages/agora/src/events/realtime/{types,route,connections}.ts` +
`apps/chrono-api/src/modules/device/realtime-actor.ts` +
`apps/chrono-api/src/modules/realtime/scope-validators.ts` +
`apps/chrono-api/src/modules/session/service.ts`. Findings:

- **Handshake**: plain WS upgrade at `GET /api/v1/device/ws`, bearer device token in
  the `Authorization` header (same credential the REST device routes use —
  `resolveDeviceAuthContext`). Optional `?scope=` query params, repeatable,
  lowercased/deduped/capped at 25 server-side. A device is already allowed to request
  `?scope=device:<its-own-deviceId>` (`validateChronoDeviceScopes` — pure string match
  against `actor.actorKey`, no DB query) — **the Tauri client must add this query
  param on connect**, it does not happen implicitly. Without it, the connection only
  gets the tenant-wide channel, never its own private one.
- **Frame shape (server → client)**: every pushed frame is `{ event: string, payload:
  unknown }` JSON text (`route.ts`'s `onOpen` subscribe callback: `ws.send(JSON.stringify({
  event, payload }))`). No envelope beyond that — `event` is the discriminator
  (`"session.state"` is the one that already exists, see below).
- **Frame shape (client → server, inbound)**: raw JSON text only (binary frames are
  rejected with close code 1003); size-capped (`maxFrameBytes: 2048` for the device
  mount) and rate-capped (`inboundFramesPerMin: 30`). The device mount's `onFrame`
  today only exists to drop any frame naming a foreign `deviceId` — no frame TYPE is
  handled yet. Phase 3 adds `{ type: "command-ack", commandId, result }` as the first
  real inbound type, gated the same way (drop if `data.deviceId` is present and
  doesn't match `actor.actorKey`; no `stationId` field involved here since a command
  targets the device directly).
- **Ping/pong**: protocol-level WS ping/pong, fully internal to `route.ts` — no
  application-level heartbeat frame to implement client-side beyond answering pings
  (which every real WS client library does automatically, same as `rust_socketio` did
  as a transport concern, not app logic).
- **Push-on-issue mechanism (the thing Phase 3/4 needed confirmed)**: there is **no
  per-connection `send()`** exposed by the registry (`connections.ts` only tracks
  `close()`, for revocation). A server handler pushes to ONE connected device by
  `getRealtimeProvider().publish(tenantScopeChannel(tenantId, \`device:${deviceId}\`),
  "<event>", payload)` — publishing to that device's own private scope channel, which
  only its own connection is subscribed to (because it, and only it, is allowed to
  request that scope). **This pattern already ships**: `session/service.ts`'s
  `publishSessionTransition` already does exactly this for `"session.state"` on every
  session start/end (looks up the station's approved device fresh, publishes to
  `device:${device.id}`) — Phase 3's command push and Phase 4's wallet-low push are
  the same one-line call, not new plumbing.
- **Command-ack tenant/device scoping** (the plan-audit condition): `withTenant(actor.tenantId,
  tx => tx.select().from(chronoDeviceCommands).where(and(eq(id, commandId),
  eq(deviceId, actor.actorKey))))` — both columns in the WHERE, mirroring
  `requireOwnDevice`'s existing pattern. Confirmed workable: nothing about the
  protocol read changes this.

### Phase 2 — Realtime transport migration (Tauri client repo, Rust)

Replace the Socket.IO client with a plain WebSocket client speaking
`agora/realtime`'s protocol (see the protocol read above — plain `{event, payload}`
JSON frames, bearer token in the upgrade request's `Authorization` header, add
`?scope=device:<ownDeviceId>` on connect to receive command pushes).

- **Files to update** (`/Users/risurina/karta/karta-tenant/apps/chrono-pc-client-tauri`):
  `src-tauri/src/realtime.rs` (rewrite transport: drop `rust_socketio`, connect with
  a plain WS client, e.g. `tokio-tungstenite`; send the bearer token as an
  `Authorization: Bearer <deviceToken>` header on the upgrade request, not a
  Socket.IO auth payload; append `?scope=device:<deviceId>` to the connect URL; parse
  every inbound text frame as `{ event, payload }` and dispatch on `event`; keep the
  existing `"device-command"` handling shape as the target for `event ===
  "device.command"` (Phase 3 below fixes the exact event name), now delivered as a
  JSON frame over plain WS instead of a Socket.IO event), `Cargo.toml` (drop
  `rust_socketio`, add `tokio-tungstenite` + `futures-util`).
- **Base URL**: derive the WS origin from `VITE_API_BASE_URL` exactly like
  `src/lib/realtime.ts` already does (per Phase 1's finding, that TS file only computes
  the origin today — Rust owns the actual socket). Confirm in Phase 1's diff table
  that `/api/v1/device/ws` is the correct path suffix (mount matches `/api/v1/device`,
  route is `.get("/ws", ...)`).
- **Step-by-step tasks**: (1) add `tokio-tungstenite`/`futures-util` to `Cargo.toml`,
  remove `rust_socketio`; (2) rewrite the connect function to open a WS with the
  bearer header + `?scope=` query param; (3) replace the Socket.IO event-listener
  registration with a read loop that JSON-parses each text frame into `{ event: String,
  payload: serde_json::Value }` and matches on `event`; (4) wire `"session.state"` to
  update the existing session-state UI store (already exists — this is a new event
  source for an existing sink, not new UI); (5) leave a typed hook for `"device.command"`
  (Phase 3's event) even if Phase 3 hasn't landed yet, so the two phases don't need to
  touch the same match arm twice; (6) remove the now-dead `client-config.ts`
  `API_BASE_URL` HTTP-construction path only if Phase 1's diff table confirmed it truly
  unused (it wasn't — it drives the WS origin — so this bullet is DONE, not a TODO: no
  removal needed, `client-config.ts` stays as-is).
- **Acceptance criteria**: client connects to a local `chrono-api`'s
  `/api/v1/device/ws` with a real paired device's bearer token, receives a
  `session.state` push when a session is started/ended for that device's station via
  the existing staff `/rpc/sessions` route, and the existing session-state UI reflects
  it with no other code changes.
- **Verification commands**: `cargo check` / `cargo build` in
  `apps/chrono-pc-client-tauri/src-tauri`; manual connect test against a local
  `chrono-api` dev server (`pnpm --filter @agora/chrono-api dev`) is the only real
  proof, per Phase 6.
- **Out of scope**: `chrono-guard`, the Windows lockdown service; any UI change beyond
  wiring the new event source into the existing store.
- **Execution start point**: read `src-tauri/src/realtime.rs` and `Cargo.toml` in
  full, then implement per the tasks above.
- **Status**: READY — protocol read complete, no remaining open question.

### Phase 3 — Device command dispatch (this repo)

- **Files to update**: `apps/chrono-api/src/modules/device/schema.ts` (new
  `chronoDeviceCommands` table — `id, tenantId, deviceId, type
  (lock|unlock|reboot|force_logout), status (pending|delivered|acked|expired),
  issuedByUserId, issuedAt, deliveredAt, ackedAt, expiresAt, result (jsonb,
  nullable)`, `tenantId` → `organization.id` `onDelete: cascade`, `*_tenant_idx`
  index — imported into `apps/chrono-api/src/db/schema.ts`); `APP_TENANT_TABLES`;
  `apps/chrono-api/src/modules/device/contracts.ts` (`issueDeviceCommandSchema`,
  `deviceCommandAckSchema`); `apps/chrono-api/src/modules/device/routes.ts` (new
  `POST /rpc/devices/:id/commands` on the STAFF-facing `/rpc` mount, `device:manage`-
  gated); `apps/chrono-api/src/modules/device/realtime-actor.ts` (`onFrame` gains
  `command-ack` handling).
- **Step-by-step tasks**: (1) schema + migration (`pnpm db:generate --name
  chrono-device-commands` + `pnpm db:migrate`, never `db:push`); (2) add to
  `APP_TENANT_TABLES`; (3) contracts; (4) `POST /rpc/devices/:id/commands`: gate
  `device:manage`, insert a `pending` row via `withTenant`, then best-effort
  `getRealtimeProvider().publish(tenantScopeChannel(tenantId, \`device:${deviceId}\`),
  "device.command", { commandId, type, expiresAt })` (the queued row is the source of
  truth — the push is latency-avoidance only, per the plan's own framing), audit via
  `recordAudit`/the module's existing audit pattern, set `status: "delivered"` +
  `deliveredAt` only if the publish succeeded (it always "succeeds" from the
  publisher's POV under the `memory` provider — there is no delivery ack at the
  transport layer, so "delivered" here means "we attempted the push", not "the
  device received it"; the real signal is the ack below); (5) `onFrame`: for `data.type
  === "command-ack"`, validate `data.commandId` is a string, look up the command via
  `withTenant(actor.tenantId, tx => ... where(and(eq(id, commandId), eq(deviceId,
  actor.actorKey))))`, update `status: "acked"`, `ackedAt`, `result` — silently drop
  if not found (forged/stale commandId) rather than closing the connection, matching
  the existing "drop, don't fail" hardening style for the `deviceId` self-check; (6)
  **offline/expiry decision (resolves Open Question 2)**: a command not acked within
  15 minutes of `issuedAt` is `expired` — implemented as a lazy check at read time (the
  next `GET`/list of commands for that device recomputes `status: "expired"` for any
  `pending`/`delivered` row past its `expiresAt`, mirroring the existing lazy-resolution
  style used elsewhere in this codebase, e.g. `resolveTenantLimits`) rather than a
  background sweep — no new cron/worker for a first version of this feature.
- **Acceptance criteria**: an `admin`/`owner` can issue a command via `POST
  /rpc/devices/:id/commands`; a `staff` role is rejected (`device:manage` is not in
  `CHRONO_STAFF_GRANTS` for `device`, confirm in `apps/chrono-api/src/auth/permissions.ts`);
  a connected device receives the push and can ack it; a forged cross-tenant
  `commandId` in an ack frame is silently dropped, never applied; `rls:proof` passes.
- **Verification commands**: `pnpm typecheck`; `pnpm db:generate` + `pnpm db:migrate`;
  `pnpm --filter @agora/api rls:proof` (this repo's DB proof script — confirm exact
  filter name matches `apps/chrono-api`'s own `package.json` script, not the scaffold's
  `@agora/api`, before running).
- **Out of scope**: a `chrono-web` admin UI to issue commands (Open Question 3,
  resolved below: REST-only this pass).
- **Execution start point**: read `apps/chrono-api/src/modules/device/{schema,
  contracts,routes,realtime-actor}.ts` in full, then implement per the tasks above.
- **Status**: READY.

### Phase 4 — Device-facing session & wallet status (this repo)

**Finding that changes this phase's scope**: `session/service.ts`'s
`publishSessionTransition` already pushes `"session.state"` to a station's approved
device on every session start/end/status change — that half of this phase's original
"genuinely new work" item 5 is **already shipped**, not new. What's actually missing:
(a) a wallet-low realtime push (nothing publishes wallet events to a device today —
confirmed, `grep` for `getRealtimeProvider`/`tenantScopeChannel` in `wallet/` returns
nothing), and (b) REST reads for a kiosk's own initial-state fetch on boot/reconnect
(the realtime push only reaches an already-open socket — a cold-started kiosk needs a
GET to know current state before the first push arrives).

- **Files to update**: new device-bearer-gated routes, mounted alongside
  `deviceAuthRoutes()` in `apps/chrono-api/src/modules/device/routes.ts` (or a small
  sibling file if that file is already large) — `GET /api/v1/device/session/active`
  (the device's own `stationId`'s current session, if any — reuse
  `chronoSession`'s existing shape, scoped by `stationId` not just `tenantId`, per
  the plan-audit condition) and `GET /api/v1/device/wallet/balance` (the session's
  member's wallet balance, `null` if no active session); `apps/chrono-api/src/modules/wallet/service.ts`
  (a `publishWalletLow` call — reuse the exact `tenantScopeChannel(tenantId,
  \`device:${deviceId}\`)` push pattern from `session/service.ts`, fired from
  `applyWalletDelta` when the resulting balance crosses below a low-balance threshold
  — reuse whatever threshold constant the wallet module already exposes for UI
  warnings, if one exists; if none exists, this phase does not invent a
  business-configurable threshold, it hardcodes the same value the existing member
  portal UI uses for its own low-balance banner, confirmed by reading that UI first).
- **Step-by-step tasks**: (1) read `session/schema.ts` + `wallet/schema.ts` +
  whatever the member portal's existing low-balance banner threshold is (`apps/chrono-web`,
  search for "low balance"/"topup" prompts) before writing the route; (2) `GET
  .../session/active`: resolve the device's own `stationId` via
  `resolveDeviceAuthContext` (already available on `c.var`), query `chronoSession`
  `where(and(eq(stationId, device.stationId), eq(status, "active")))` through
  `withTenant`, return an explicit column allowlist, never a raw row; (3) `GET
  .../wallet/balance`: same station scoping — no active session means no member
  context, return `{ balance: null }`, never guess a member; (4) wire the wallet-low
  publish into `applyWalletDelta`'s existing transaction-committed callback point
  (same "publish after commit, never inside the transaction" rule
  `publishSessionTransition`'s own doc comment states); (5) confirm neither new GET
  route can be used to enumerate another station's data — the `stationId` used in the
  WHERE must come from the device's own resolved auth context, never a route param or
  query string.
- **Acceptance criteria**: a paired device can `GET` its own station's active session
  and wallet balance; a device cannot read another station's data (tested by pointing
  a second device's bearer token at the first device's data — must 404/empty, not
  leak); a wallet crossing the low-balance threshold triggers a push to the owning
  device's private channel; `rls:proof` passes (no schema change here, but re-run per
  `.ai/rules/testing.md`'s "any change that touches `withTenant`" standard since this
  adds new tenant-scoped queries).
- **Verification commands**: `pnpm typecheck`; `pnpm --filter @agora/api rls:proof`.
- **Out of scope**: any UI beyond the Tauri client's own existing session-state
  skeleton (Phase 2 already wires it to consume `session.state`; this phase's new
  `wallet.low` event is a new event name that phase's `event` match needs one more
  arm for — flagged here so Phase 2 and Phase 4 don't silently diverge on the event
  name: **event name is `"wallet.low"`**, payload `{ balance: string }`).
- **Execution start point**: read `apps/chrono-api/src/modules/session/schema.ts` and
  `apps/chrono-api/src/modules/wallet/{schema,service}.ts` in full, then implement.
- **Status**: READY.

### Open Questions 2 & 3 — resolved

2. **Offline device command delivery**: resolved above (Phase 3) — queue as the
   source of truth (already the design), lazy-expire unacked commands after 15
   minutes at read time, no background sweep in this pass.
3. **Command-dispatch web UI**: resolved — **REST-only this pass.** The Tauri client
   is the only consumer; a `chrono-web` admin UI to issue lock/reboot/force-logout
   commands is deferred to a follow-up plan once the REST surface is proven. Phase 3
   above stays scoped to `apps/chrono-api` only, no `apps/chrono-web` files.

### Phase 5 — Kiosk login → session start (this repo)

**Resolved** (dedicated research pass): confirmed no device-initiated session-start
route exists. `POST /rpc/sessions` requires a staff Better Auth session
(`tenantMiddleware()`); `/portal/sessions/*` is read-only under `memberMiddleware()`;
`reservation` only creates a member-scoped hold, consumed later through the normal
member/staff paths — no QR-to-device-endpoint flow exists anywhere.

- **Files to update**: `apps/chrono-api/src/modules/device/routes.ts` (or the Phase-4
  sibling `status-routes.ts`) — new `POST /api/v1/device/session/start`,
  device-bearer-gated via `requireDeviceBearerAuth()`; `apps/chrono-api/src/modules/device/contracts.ts`
  (request schema: `{ memberEmail: string, memberPassword: string }`).
- **Step-by-step tasks**: (1) resolve `tenantId`/`stationId` from `c.var.device`
  ONLY — never a route param/body field; reject 404 if `device.stationId` is null
  (unlinked/unapproved device); (2) verify the posted `memberEmail`/`memberPassword`
  against `tenantMember` using the existing password-verify helper from
  `packages/agora/src/identity/member-auth/index.ts` (reuse, do not
  re-implement hashing/verification) — scoped to the device's own `tenantId`; (3) on
  success, call `startSession()` (`session/service.ts` — its own doc comment already
  names it "the ONLY code path that starts a session") inside `withTenant`, with
  `startedByUserId: null` (same as the existing anticipated self-service path) and
  `stationId: device.stationId`; (4) call `publishSessionTransition` after the
  transaction commits, identical shape to the existing staff `POST /sessions` handler;
  (5) **add a per-device rate limiter** (mirroring `deviceSecurityAlertLimiter`'s
  per-`deviceId` bucket pattern in `device/routes.ts`) in addition to whatever
  per-email bucket the existing member password-verify path already uses — a
  kiosk-forwarded flow shares one IP bucket across every customer at that station, so
  the per-device bucket is a REQUIRED addition, not optional hardening, to prevent one
  kiosk's shared IP from locking out unrelated customers on a run of wrong guesses.
- **Acceptance criteria**: a customer can start a session at a kiosk by entering
  email+password, which starts a session scoped to that device's own station; wrong
  credentials return 401 without leaking which field was wrong; a device with no
  linked/approved station cannot start any session; the per-device rate limit trips
  independently of the per-email one; `rls:proof` passes.
- **Verification commands**: `pnpm --filter @agora/chrono-api typecheck`;
  `pnpm --filter @agora/chrono-api rls:proof`.
- **Out of scope**: QR-code claim variant (email+password only, this pass); any
  Tauri-client UI beyond wiring the existing login form to this new endpoint instead
  of whatever it calls today (a Tauri-side follow-up, not bundled into this phase).
- **Execution start point**: read `apps/chrono-api/src/modules/session/service.ts`
  (`startSession`), `packages/agora/src/identity/member-auth/index.ts` (password
  verify), and `apps/chrono-api/src/modules/device/routes.ts`'s existing
  `deviceSecurityAlertLimiter` pattern in full, then implement.
- **Status**: READY.

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
