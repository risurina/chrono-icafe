# Chrono realtime updates (station status, staff dashboard, device channel)

**Status: Draft, revised after plan-auditor pass 1 (verdict: NEEDS REVISION → fixes
applied). Not implementation-ready — blocked on the dependencies below.**

**Hard dependencies (all must land first):**
1. `.ai/plans/agora/active/websocket-foundation/README.md` Phases 1–3 — supplies the
   transport (`createRealtimeRoute`), tenant-namespaced channels, scope sets, per-mount
   limits including `requireOrigin`, and `closeConnections`.
2. `.ai/plans/chrono/active/sessions/README.md` — **the session module has no
   `routes.ts` today** (`apps/chrono-api/src/modules/session/` holds only `schema.ts`,
   `contracts.ts`, `money.ts`, and is still untracked). Session status transitions do
   not exist to publish from. Phase 2 below is split so station-only work can proceed
   without it.
3. The QR check-in flow (`.ai/plans/chrono/active/qr/`) — it starts sessions outside the
   session routes and is therefore a publish point.

## Context

The sessions and devices plans both deferred realtime work to a plan of this name. This
plan supplies only Chrono's vocabulary and wiring — no transport code.

Prior art is oikos's Socket.IO layer, which is **not** being ported: it was a
non-load-bearing UX layer over a REST/poll system, with a background poll correcting
dropped events and client-computed countdowns. That posture is deliberately kept; the
transport is not.

## Actor classes (three, deliberately separate)

| Actor | Endpoint | Auth | Channels |
|---|---|---|---|
| Staff browser | `/rpc/realtime` (foundation staff mount) | member session cookie via `tenantMiddleware` | `tenant:{t}` + per on-screen scope (below) |
| Station/kiosk device | `/api/v1/device/ws` (Chrono's own mount) | device bearer token + `X-Device-Fingerprint` | `tenant:{t}:device:{deviceId}` only — 1:1, private |
| Public customer | **no websocket** | anonymous | — (unchanged: cached poll) |

### Public customer availability — explicitly NOT a websocket

`.ai/plans/chrono/active/public-stations/README.md:155-166` already serves
`{tenantSlug}.CHRONO_DOMAIN/stations` anonymously behind a 5–10s per-tenant cache, an IP
rate limit (~1 req/3s) and a 15s client poll, with a payload narrowed to aggregate counts
+ per-station name/number/status. **That design stands unchanged**, because:

- PC availability changes on a human timescale; a cached poll is indistinguishable to the
  viewer at a fraction of the cost.
- There is no authenticated principal to rate-limit against — only an IP.
- A shared branch room would tempt reusing the staff event payload, silently re-adding
  the rates/queue fields the public contract deliberately excluded.

If the page later needs to feel live, SSE over the same cached aggregate is the next
step — not because it costs fewer connections (it does not; that argument is wrong and is
not made here), but because it is one-way, carries no per-viewer subscription or auth
state, and cannot share a room with staff events. **Out of scope here.**

## Staff dashboard wiring

**Scope vocabulary** (Chrono's `validateScopes`, batched per the foundation seam — one
`IN (…)` query, not N lookups). Two kinds, because **the provider is channel-keyed with
no per-event filter**: putting both event granularities on one channel would deliver
every per-station frame to an overview that only renders counts, reintroducing exactly
the fan-out cost sub-rooms exist to avoid.

| Scope | Channel | Events | Consumer |
|---|---|---|---|
| `branch:{id}` | `tenant:{t}:branch:{id}` | `station.status` (per-station transition) | single-branch station grid |
| `branch-summary:{id}` | `tenant:{t}:branch-summary:{id}` | `branch.summary` (counts only) | multi-branch overview |

Both validate identically: the branch exists and belongs to `c.var.tenant.tenantId` (via
`withTenant`). A page subscribes only to what it renders — never "all branches by
default". The foundation caps the set at 25.

**No permission gate on subscribing, by design.** `apps/chrono-api/src/auth/
permissions.ts` has no `station:read`/`branch:read` action, and station/branch GETs are
ungated and membership-only (`station/routes.ts:96,139`). `validateScopes` therefore does
a tenant-ownership check and **no** `requirePermission` call — consistent with the
existing surface. Inventing a gate here would be a gate no HTTP route enforces.

**Non-load-bearing, as in oikos**: every realtime-updated view keeps its poll as a
backstop (lengthened, since the socket carries the fast path). A dropped event self-heals
on the next poll; no view treats the socket as its only source of truth. Session
countdowns stay **client-computed** from the session's known start/end — never a
per-second server tick.

### Emit points (explicit inventory — "the session/station modules emit" is not enough)

| Trigger | Location | Emits |
|---|---|---|
| Station create / PATCH | `station/routes.ts:324,374` | `station.status` + recomputed `branch.summary` |
| Device approve (creates a station row) | `device/routes.ts:151` | same |
| Session start / pause / resume / extend | session routes (pending dep. 2) | same |
| Session end | **`endSessionCore`** (sessions plan:175) | same |
| Session expiry sweep | `session/expiry.ts` (sessions plan:317-362) | same |
| QR scan check-in | qr module | same |

Two rules this table exists to enforce:
- The end-of-session emit lives inside the shared **`endSessionCore`**, not in the route,
  so the route and the background sweep cannot diverge.
- **The expiry sweep has no request context** — it is a cross-tenant `setInterval` with
  no `c.var.tenant`. Its publish must derive `tenantId` from each closed row and publish
  per-tenant, and it must run in the same process as the memory provider. This is the
  single most likely source of a status change a staff screen needs live, and the easiest
  one to miss.
- Device *revoke* deliberately does not change station status (devices plan:587) and
  therefore emits no `station.status`.

### Event contracts and the web app's access to them

Per `.ai/rules/business-app.md` the contracts live in the module's own `contracts.ts` —
but `apps/chrono-api/package.json` currently exports **only** `"./app"`, and realtime
payloads never pass through `RpcType` inference (they are published, not returned by a
handler), so `apps/chrono-web` has no typed path to them. **Decision**: add a
`"./realtime"` export to `apps/chrono-api/package.json` re-exporting the module event
schemas, listed in Phase 1's file list.

## Station/device channel

Reuses Chrono's existing device credential — **no new auth mechanism, no JWT, no
per-message HMAC**. Verified against `device-auth-middleware.ts:7-20,38-74`: a permanent
per-device random token stored only as SHA-256 in `ChronoDevices.tokenHash`, located by a
cross-tenant `withAdmin` lookup on that hash (constant-time compare via
`packages/agora/src/server/api-key.ts:73-83`) with the fingerprint checked alongside it
(a plain `!==` at `device-auth-middleware.ts:59` — the row is already located by hash
equality, so this is fine, but the credential is not "constant-time on both halves" and
this plan does not claim it is). Yields `c.var.device`, never merged into `TenantVars`.

Reusing it at handshake is sound: it is a stateless credential check with no per-request
side effects, so running it once at upgrade is the identical check. The only thing lost
is per-request re-validation — which is exactly what `revalidateEveryMs` restores.

- **Own mount, `/api/v1/device/ws`** — alongside the existing device REST routes, outside
  `/rpc` and `tenantMiddleware()`. Mandatory, not stylistic: a device has no session, so
  `tenantMiddleware` would 401 it before `createEvents` ran.
- **`requireOrigin: false`** — a kiosk agent is not a browser and sends no `Origin`; the
  foundation's staff mount rejects a missing `Origin`, which would refuse every device.
  The compensating control is the bearer credential: there is no ambient credential a
  browser could be tricked into replaying cross-site, so CSWSH does not apply.
- **Maintenance gate: deliberately bypassed.** `app.ts:770` mounts
  `.route("/api/v1/device", deviceAuthRoutes())` *before* `.use("/api/v1/*",
  maintenanceReadOnlyGate)` at `:785`, so device traffic already skips that gate. The WS
  mount inherits the bypass, and that is **intended** — a kiosk should not lose its
  socket during a platform maintenance window. Recorded explicitly so a later reviewer
  doesn't "fix" the mount order and silently disconnect every kiosk.
- **`resolveActor`** verifies token + fingerprint, takes `tenantId` from the matched row
  (never the client), returns `{ tenantId, actorKey: deviceId }`. Unknown/malformed →
  401; non-`approved` → 403; indistinguishable, matching the REST middleware.
- **Channel**: `tenant:{t}:device:{deviceId}` only. **A device never joins a branch
  room** — nothing in the kiosk flow needs floor-wide state, and the station agent is the
  least-trusted software in the system (it runs on hardware customers physically touch).
- **`limits`**: `maxLifetimeMs: 12h` (a nightly backstop — the foundation forbids `null`,
  since a revocation hook alone fails open), `revalidateEveryMs: 5min`,
  `heartbeatMs: 30_000`, `maxPerActor: 2` (one live + one reconnecting), small frame cap.
- **Revocation closes the socket**: revoke / unapprove / relink call
  `closeConnections({ actorKey: deviceId })` from the existing device routes — the fast
  path, with the re-validation tick as the correctness guarantee.
- **Heartbeat maintains liveness**: the 30s ping updates `connectivityStatus`/
  `lastSeenAt`, superseding the REST heartbeat's polling while the socket is up (the REST
  endpoint stays for devices that cannot hold a socket).
- **Inbound frames**: the device reports only **its own** status/ack. Foundation
  hardening applies; additionally a frame referencing any `stationId`/`deviceId` other
  than the one its connection resolved to is dropped.
- **Server→device events in this plan**: `session.state` for the device's own station is
  published to its private channel at the same emit points as `station.status`, so a
  kiosk learns when staff start or end a session at the counter. Without this the device
  channel would have no consumer at all and Phase 3 would ship dead code.

### Remote commands (lock / unlock / restart) — deferred, not designed here

Both the devices and sessions plans list remote commands as out of scope, so this plan
ships the channel and its security model without a command vocabulary. When commands are
taken up (its own plan):

- Server→device on the private channel, carrying a `commandId` with a device-side dedupe
  window and an explicit ack — so staff UI distinguishes *delivered* from *applied*.
- **Idempotency, not signatures.** With Chrono terminating both ends over `wss://` and no
  third party to prove origin to, per-message HMAC adds nothing TLS does not already
  provide; the dominant risk is token theft from the kiosk itself, against which a
  device-held HMAC key is equally compromised. **This assumes the kiosk client validates
  (ideally pins) the server certificate** — on a hostile LAN with an injected CA, TLS
  provides no integrity and this rationale collapses. That requirement carries to the
  commands plan.

## Open questions (answer before implementation, not during)

1. **What does a `stationId: null` device receive and report?** (Rewritten — the original
   "one device, many stations" question is already answered by the schema: `stationId` is
   a single nullable FK with a partial unique index allowing at most one approved device
   per station (`device/schema.ts:93-95`), so a multi-seat device is not representable
   and would be a schema change, not a channel-design change.) A `pending_approval` or
   unassigned device gets a channel with nothing to report — decide whether it connects
   at all.
2. **Poll interval after realtime lands** — the backstop should lengthen, but by how much
   depends on acceptable staleness when a socket is down.

*(The former Open Question 2 — event granularity — is resolved above by the two-scope
channel split.)*

## Out of scope

- The transport itself (foundation plan).
- Public/customer realtime — stays a cached poll.
- Remote device commands — deferred.
- Session countdown as a server-pushed tick — stays client-computed.
- Cross-instance pub/sub (Redis) — foundation concern.

## Phases (shape only — not expanded to the Concreteness Gate until the dependencies land)

1. Scope vocabulary + `validateScopes` + `station.status`/`branch.summary`/
   `session.state` contracts in the module's `contracts.ts`, plus the `"./realtime"`
   package export.
2. **2a** — station-only emit points (station PATCH, device approve) + staff dashboard
   subscription + poll-interval change. Ships without dep. 2.
   **2b** — session emit points (`endSessionCore`, expiry sweep, QR check-in). Requires
   the sessions plan.
3. `/api/v1/device/ws` mount, device `resolveActor`, `session.state` publish, revocation
   hook wiring.
4. E2E per `.ai/rules/e2e-testing.md`: happy path, cross-tenant isolation, device-channel
   isolation (device A receives nothing addressed to device B), and — since subscription
   has **no** role gate by design — the role-gate leg is satisfied by asserting the
   *device* gate (a non-`approved` device is refused 403) plus the producing mutation's
   own existing gate (`station:update`).
