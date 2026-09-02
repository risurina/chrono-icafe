# Chrono realtime updates (station status, staff dashboard, device channel)

**Status: Draft — not yet implemented. Depends on
`.ai/plans/agora/active/websocket-foundation/README.md` landing first (Phases 1–3).**

## Context

`.ai/plans/chrono/active/sessions/README.md` and `.../devices/README.md` both deferred
realtime work to a plan of this name. The foundation plan now supplies the transport:
an actor-agnostic `createRealtimeRoute({ resolveActor, validateScope, limits, onFrame })`,
tenant-namespaced channels (`tenant:{tenantId}[:{scope}]`), a validated scope **set** per
connection, per-endpoint limits, and `closeConnections(predicate)` for revocation. This
plan supplies only Chrono's own vocabulary and wiring — no transport code.

Prior art is oikos's Socket.IO layer, which is **not** being ported: it was a
non-load-bearing UX layer over a REST/poll system, with a background poll running
alongside the socket to correct dropped events, and client-computed countdowns. That
posture is deliberately kept (see "Non-load-bearing" below); the transport is not.

## Actor classes (three, deliberately separate)

| Actor | Endpoint | Auth | Channels |
|---|---|---|---|
| Staff browser | `/rpc/realtime` (foundation staff mount) | member session cookie via `tenantMiddleware` | `tenant:{t}` + `tenant:{t}:branch:{b}` per on-screen branch |
| Station/kiosk device | `/api/v1/device/ws` (Chrono's own mount) | device bearer token + `X-Device-Fingerprint` (existing `ChronoDevices` credential) | `tenant:{t}:device:{deviceId}` only — 1:1, private |
| Public customer | **no websocket** | anonymous | — (unchanged: cached poll) |

### Public customer availability — explicitly NOT a websocket

`.ai/plans/chrono/active/public-stations/README.md` already serves
`{tenantSlug}.CHRONO_DOMAIN/stations` fully anonymously, tenant resolved by host parse,
behind a short-TTL per-tenant cache + IP rate limit, with a payload deliberately narrowed
to aggregate counts + per-station name/number/status. **That design stands unchanged.**
Reasons, per the foundation plan's "What does not get a websocket":

- Every anonymous visitor would cost a persistent connection with no authenticated
  principal to rate-limit against — a connection-exhaustion surface.
- PC availability changes on a human timescale; a cached poll is indistinguishable to the
  viewer at a fraction of the cost.
- A shared branch room would tempt reusing the staff event payload, silently re-adding
  the rates/queue fields the public contract excluded.

If the public page later needs to feel live, the next step is SSE over the same cached
aggregate — one-way, no per-viewer auth state — not a websocket. **Out of scope here.**

## Staff dashboard wiring

- **Scope vocabulary**: Chrono supplies `validateScope` accepting `branch:{branchId}`
  only (MVP). It verifies the branch exists and belongs to `c.var.tenant.tenantId`
  (via `withTenant`), rejecting anything else — so a crafted scope cannot address another
  tenant's branch even before the channel prefix makes it impossible.
- **Subscription set matches what is on screen**, never "all branches by default":
  - single-branch station grid → `?scope=branch:{id}` → receives that branch's
    per-station events;
  - multi-branch overview → the set of branches actually rendered (foundation caps the
    set at 25);
  - a page with no branch context → tenant-wide channel only.
- **Two event granularities**, so an overview does not pay per-station cost:
  - `station.status` (per-station transition: available/occupied/maintenance/offline),
    published to `tenant:{t}:branch:{b}` — consumed by the single-branch grid;
  - `branch.summary` (counts only), published to the same branch channel — consumed by
    the multi-branch overview, which renders counts and has no use for individual
    transitions.
- **Non-load-bearing, as in oikos**: every realtime-updated view keeps its existing poll
  as a backstop (a longer interval than today's, e.g. 30–60s, since the socket carries
  the fast path). A dropped event must self-heal on the next poll; no view may treat the
  socket as its only source of truth. Session countdowns stay **client-computed** from
  the session's known start/end — never driven by a per-second server tick.

## Station/device channel

Reuses Chrono's existing device credential — **no new auth mechanism, no JWT, no
per-message HMAC**. The devices plan already settled this: a permanent per-device random
token stored only as SHA-256 in `ChronoDevices.tokenHash`, verified constant-time
alongside `X-Device-Fingerprint` against the same row, yielding a distinct `c.var.device`
never merged into `TenantVars`.

- **Own mount, `/api/v1/device/ws`** — alongside the existing device REST routes, outside
  `/rpc` and `tenantMiddleware()`, exactly as those routes already are. Device traffic
  never enters the staff mount; merging the two is how a device ends up holding a
  member's permission set.
- **`resolveActor`** verifies token + fingerprint, takes `tenantId` **from the matched
  row** (never from the client), returns `actorKey: deviceId` and the single channel
  `tenant:{t}:device:{deviceId}`. Unknown/malformed → 401; non-`approved` → 403;
  indistinguishable responses, matching the REST middleware's existing discipline.
- **A device never joins a branch room.** It receives only its own channel. A station
  agent runs on hardware customers physically touch and is the least-trusted software in
  the system; giving it the floor's full status is an unnecessary disclosure.
- **`limits`**: `maxLifetimeMs: null` (a kiosk holds a stable long-lived connection and
  reconnects on drop — the staff mount's 15-minute forced re-handshake is wrong here),
  `heartbeatMs: 30_000`, `maxPerActor: 2` (one live + one reconnecting), small frame cap.
- **Revocation closes the socket.** Revoking, unapproving, or relinking a device calls
  the foundation's `closeConnections({ actorKey: deviceId })` from the existing device
  routes. This is load-bearing precisely because the device mount has no lifetime
  backstop.
- **Heartbeat maintains liveness**: the transport's 30s ping updates
  `connectivityStatus`/`lastSeenAt`, superseding the REST heartbeat endpoint's polling
  while the socket is up (the REST endpoint stays for devices that cannot hold a socket).
- **Inbound frames** are limited to the device reporting **its own** status/ack. The
  foundation's hardening applies (size cap, per-connection rate limit, Zod validation);
  additionally, a frame referencing any `stationId`/`deviceId` other than the one its
  connection resolved to is dropped, not honored.

### Remote commands (lock / unlock / restart) — deferred, not designed here

Both the devices and sessions plans list remote device commands as explicitly **out of
scope**, so this plan ships the device *channel* and its security model without a command
vocabulary. When commands are taken up (its own plan):

- They are server→device on the private device channel, and carry a `commandId` with a
  device-side dedupe window plus an explicit ack frame — so staff UI can distinguish
  *delivered* from *applied* instead of assuming.
- **Idempotency, not signatures, is the requirement.** Over `wss://` on a
  handshake-authenticated connection, per-message HMAC (oikos's design) buys little —
  TLS already provides integrity and there is no third party to prove origin to. Add
  nonce/timestamp signing only if a command ever traverses a channel Chrono does not
  control.

## Open questions (must be answered before implementation, not during)

1. **Per-station or per-device connection when one machine hosts multiple seats?**
   `ChronoDevices.stationId` is nullable, so a device is not always exactly one station.
   The channel design above assumes one connection per *device*; if a machine ever drives
   several stations, the mapping from device channel to affected stations needs stating.
2. **Does the multi-branch overview want `branch.summary` only, or both granularities?**
   Depends on the real UI, which is not built. Picking wrong costs either a redundant
   event stream or a second round of plumbing.
3. **Poll interval after realtime lands** — the backstop interval should lengthen, but by
   how much depends on how much staleness is acceptable when a socket is down.

## Out of scope

- The transport itself (foundation plan).
- Public/customer realtime — stays a cached poll, see above.
- Remote device commands — deferred, see above.
- Session countdown as a server-pushed tick — stays client-computed.
- Cross-instance pub/sub (Redis) — foundation concern, not needed at current scale.

## Phases

Phases are deliberately not expanded to the Concreteness Gate yet: this plan cannot be
implementation-ready until the foundation plan's Phases 1–3 have landed (its seams are
what these phases call) and the three open questions above are answered. Intended shape:

1. `validateScope` + branch scope vocabulary + `station.status`/`branch.summary` event
   contracts (Chrono's own `contracts.ts`, per `.ai/rules/business-app.md`).
2. Publish points in the session/station modules (status transitions emit to the branch
   channel), staff dashboard subscription + poll-interval change.
3. `/api/v1/device/ws` mount, device `resolveActor`, revocation hook wiring.
4. E2E per `.ai/rules/e2e-testing.md`: happy path, role gate, cross-tenant isolation,
   plus device-channel isolation (device A receives nothing addressed to device B).
