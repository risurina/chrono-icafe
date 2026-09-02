# Chrono realtime updates (station status, staff dashboard, device channel)

**Status (2026-09-02): all three hard dependencies now satisfied — implementation-ready,
Concreteness Gate expanded below.** The dependency notes below are kept as historical
context; each is confirmed landed against the real repo, not assumed from stale plan
text (this session found several plan docs stale in both directions).

**Hard dependencies (all confirmed landed):**
1. `.ai/plans/agora/archive/websocket-foundation/README.md` — all 4 phases landed and
   independently re-verified this session. Supplies the transport
   (`createRealtimeRoute`, `packages/agora/src/realtime/route.ts`), tenant-namespaced
   channels, scope sets, per-mount limits including `requireOrigin`, and
   `closeConnections`.
2. `apps/chrono-api/src/modules/session/routes.ts` **exists** (confirmed by `ls` —
   the module now has `schema.ts`, `contracts.ts`, `service.ts`, `routes.ts`,
   `portal-routes.ts`, `expiry.ts`, `money.ts`, `concurrency.test.ts`; the `sessions`
   plan itself is fully archived). Session status transitions exist to publish from.
3. `apps/chrono-api/src/modules/qr/` **exists in full** — `schema.ts`, `contracts.ts`,
   `token.ts`, `routes.ts`, `public-routes.ts`, `routes.test.ts` — the `qr` plan is
   archived. The QR check-in flow's session-start publish point is real.

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

## Open questions — RESOLVED (2026-09-02, developer + plan-author decision)

1. **What does a `stationId: null` device receive and report?** A `pending_approval` or
   unassigned device **does not connect at all** — `resolveActor` for the device mount
   403s any device whose `status !== "approved"`, before the upgrade completes, mirroring
   this codebase's deny-by-default posture everywhere else (permission gates, RLS). An
   unapproved device already has no channel content to receive (no `stationId`, no
   session), so refusing the connection costs it nothing — the pairing flow's own REST
   endpoints (`/api/v1/device/auth`, `/pair`) remain how a device learns its approval
   state, unchanged by this plan. This also means the device mount's `resolveActor` must
   read `chronoDevice.status` fresh on every connection attempt, not cache it — an
   admin revoking a device mid-connection is handled by the existing `closeConnections`
   revocation hook (see `device:revoke`'s route, Phase 3 below), not by this check.
2. **Poll interval after realtime lands** — **developer decision: keep the current
   interval unchanged.** Realtime is additive, not a replacement for the poll's role;
   the poll keeps its existing cadence as the backstop, with no lengthening in this pass.
   Revisit only if the poll's request volume becomes a real cost once realtime is proven
   in production.

*(The former Open Question 2 — event granularity — is resolved above by the two-scope
channel split.)*

## Out of scope

- The transport itself (foundation plan).
- Public/customer realtime — stays a cached poll.
- Remote device commands — deferred.
- Session countdown as a server-pushed tick — stays client-computed.
- Cross-instance pub/sub (Redis) — foundation concern.

## Phase 1 — Scope vocabulary, event contracts, staff mount

**Files to update**
- `apps/chrono-api/src/modules/realtime/contracts.ts` (new) — `stationStatusEventSchema`,
  `branchSummaryEventSchema`, `sessionStateEventSchema` (Zod, per the shapes implied by
  the Emit points table above — a `station.status` payload carries at minimum
  `{stationId, branchId, status}`; a `branch.summary` payload carries per-status counts
  for that branch; a `session.state` payload carries `{sessionId, stationId, status}`).
  Also `chronoRealtimeScopeSchema` (the `branch:{id}` / `branch-summary:{id}` union) and
  `validateChronoScopes` (the batched `IN (…)` tenant-ownership check against
  `chronoBranch`, per the "Scope vocabulary" section above).
- `apps/chrono-api/package.json` — add `"./realtime": "./src/modules/realtime/contracts.ts"`
  to `exports`, per "Event contracts and the web app's access to them" above.
- `apps/chrono-api/src/routes/rpc.ts` — mount the foundation's staff realtime route
  (`createRealtimeRoute` from `agora/realtime`, using `createStaffActorResolver` from
  `agora/realtime` for `resolveActor`, and Chrono's own `validateChronoScopes` for
  `validateScopes`) at `/realtime` alongside the rest of `/rpc` (mirrors how
  `apps/agora-api` mounted its own staff realtime route in the foundation plan — copy
  that mount verbatim, swapping in Chrono's `validateScopes`).

**Step-by-step tasks**
1. Read `packages/agora/src/realtime/{types,route,staff-actor}.ts` and
   `apps/agora-api/src/routes/rpc.ts`'s `GET /realtime` mount in full first — copy that
   mount's shape exactly for Chrono, changing only `validateScopes` and the app-specific
   `webOrigins`/`rootDomain` passed to `createStaffActorResolver`.
2. Define the three event schemas and the scope schema in Chrono's own
   `modules/realtime/contracts.ts` — this module owns no table and no service, only
   contracts + the `validateScopes` function, matching `reconciliation`'s own
   "no entity of its own" precedent.
3. Implement `validateChronoScopes(scopes, actor)`: parse each scope against
   `chronoRealtimeScopeSchema`, extract the referenced `branchId`s, run ONE
   `chronoBranch` query scoped by `actor.tenantId` (`IN (...)`) to confirm every
   referenced branch belongs to the tenant, return the accepted subset (per the
   `ValidateScopes` contract from Phase 1 of the foundation plan — batched, not
   per-scope).
4. Add the `"./realtime"` package export and mount `/rpc/realtime`.

**Acceptance criteria**
- `pnpm typecheck` passes with the new contracts consumed by nothing yet (Phase 2 wires
  the first publisher).
- A staff session can open `GET /rpc/realtime?scope=branch:{realBranchId}` and the
  upgrade succeeds; the same call with a cross-tenant branch id is rejected 403 (proving
  `validateChronoScopes`'s tenant-ownership check, not just that scopes parse).
- No new permission resource is added to `apps/chrono-api/src/auth/permissions.ts` —
  subscribing is deliberately ungated, per "No permission gate on subscribing, by
  design" above. Confirm by grepping the diff for that file — it must be empty.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` (this phase reads `chronoBranch` but adds
  no schema/RLS change — run as the standing regression check per
  `.ai/rules/testing.md`)

**Out-of-scope:** no publisher exists yet (Phase 2); no device mount (Phase 3).

**Execution start point:** `apps/chrono-api/src/modules/realtime/contracts.ts`.

---

## Phase 2a — Station-only emit points + staff dashboard subscription

Ships without dependency on session emit points (2b) — station/branch data alone is
useful and independently testable.

**Files to update**
- `apps/chrono-api/src/modules/station/routes.ts` — after a successful station create/
  update (`:324,374` per the Emit points table — re-read the file first, line numbers
  drift), publish `station.status` to `tenant:{t}:branch:{branchId}` and a recomputed
  `branch.summary` to `tenant:{t}:branch-summary:{branchId}`, both via
  `getRealtimeProvider().publish(...)` inside the same handler, after the DB write
  commits (never inside the `withTenant` transaction itself — a publish is not
  transactional and must not roll back with the write).
- `apps/chrono-api/src/modules/device/routes.ts` — same two publishes after the approve
  handler creates/links a station row (`:151` per the table).
- `apps/chrono-api/src/modules/realtime/service.ts` (new) — a small
  `computeBranchSummary(tx, branchId)` helper (counts stations by status for that
  branch) shared by both call sites above, so the two emit points cannot compute the
  summary differently.
- `apps/chrono-web/src/lib/realtime.ts` (new) — a thin Chrono-side wrapper over
  `agora/client`'s `connectRealtime()`, typed against this module's own event schemas
  (import from `@agora/chrono-api/realtime` via the new package export).
- `apps/chrono-web/src/app/dashboard/stations/page.tsx` (and any branch-overview page,
  if one already exists — check first) — subscribe to `branch:{id}` (single-branch grid)
  or `branch-summary:{id}` (multi-branch overview) on mount, update local state on each
  event, keep the existing poll unchanged per the developer's explicit decision above
  (do not lengthen or remove it — the poll and the socket run side by side, the socket
  is purely an additive fast path).

**Step-by-step tasks**
1. Implement `computeBranchSummary`.
2. Wire the two station-module publish points and the one device-module publish point,
   each calling `computeBranchSummary` after its own write.
3. Build the web client wrapper and wire the stations page to update from live events
   in addition to its existing poll (both sources write to the same local state; an
   event and a poll response racing is harmless — both describe the same eventually-
   consistent truth).

**Acceptance criteria**
- Creating or updating a station while a second browser tab holds an open `branch:{id}`
  subscription updates that tab's UI with no reload and no poll tick elapsed (assert via
  the e2e harness's realtime test-publish pattern from the foundation plan, or via a
  real two-tab Playwright test — mirror whichever the foundation plan's own Phase 3 e2e
  spec used).
- A device-approval-created station triggers the identical two publishes.
- The existing poll interval is unchanged (grep the polling `setInterval`/`useEffect`
  call site's literal ms value before and after this phase — it must be identical).

**Verification commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-web typecheck` · `pnpm --filter @agora/chrono-web build`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-scope:** session emit points (2b); device channel (Phase 3).

**Execution start point:** `apps/chrono-api/src/modules/realtime/service.ts`
(`computeBranchSummary`), since both emit points depend on it.

---

## Phase 2b — Session emit points

**Files to update**
- `apps/chrono-api/src/modules/session/service.ts` — inside the shared `endSessionCore`
  (the single function both the route and the expiry sweep call — confirmed to exist,
  read it in full first), publish `station.status` + recomputed `branch.summary` for
  that session's station, exactly as Phase 2a's helper does. Session start/pause/resume/
  extend get the same two publishes at their own existing call sites in
  `session/routes.ts`.
- `apps/chrono-api/src/modules/session/expiry.ts` — the background sweep has no
  `c.var.tenant`; for each session it closes, derive `tenantId` from the row itself and
  publish per-tenant (per "The expiry sweep has no request context" above — this is the
  one call site most likely to be missed).
- `apps/chrono-api/src/modules/qr/public-routes.ts` (or wherever the QR check-in
  actually starts a session — read `qr`'s routes in full first, the plan's own text
  flags this as "starts sessions outside the session routes") — same two publishes
  after a successful check-in.

**Step-by-step tasks**
1. Read `endSessionCore` and confirm every session-ending path (manual end, expiry
   sweep) already routes through it — if any path does not, that is a pre-existing bug
   outside this plan's scope; note it rather than silently fixing it here.
2. Add the publish call inside `endSessionCore` itself, using Phase 2a's
   `computeBranchSummary` helper.
3. Add the same two publishes at session start/pause/resume/extend in `session/routes.ts`.
4. Fix the expiry sweep's per-tenant derivation — this runs in a `setInterval` with no
   request context, so `tenantId` must come from each closed row, and the publish must
   happen in the same process as the memory provider (true today since there's one
   Chrono API process; note this assumption for a future multi-instance deploy).
5. Wire the QR check-in's session-start publish.

**Acceptance criteria**
- Starting, pausing, resuming, extending, and ending a session (both manually and via
  the expiry sweep) each trigger the two publishes, verified against a real Postgres +
  real in-process provider (mirror `session/concurrency.test.ts`'s harness style for a
  focused test, or extend it).
- A QR check-in publishes identically to a manual session start.
- Device *revoke* still emits nothing (unchanged, per "Device revoke deliberately does
  not change station status" above) — a regression test asserting silence here is as
  important as the positive assertions.

**Verification commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- Re-run `pnpm --filter @agora/chrono-api test:session-concurrency` to confirm the new
  publish calls don't regress the existing concurrency guarantees.

**Out-of-scope:** device channel (Phase 3); remote commands (deferred, separate plan).

**Execution start point:** `apps/chrono-api/src/modules/session/service.ts`
(`endSessionCore`).

---

## Phase 3 — Device channel (`/api/v1/device/ws`)

**Files to update**
- `apps/chrono-api/src/modules/device/realtime-actor.ts` (new) — the device
  `ResolveActor`: verifies bearer token + fingerprint via the existing
  `device-auth-middleware.ts`'s own lookup logic (reuse its function, do not
  reimplement the hash lookup), returns `{ tenantId, actorKey: deviceId }`; throws 401
  for unknown/malformed credentials, 403 for a non-`approved` device — **per the
  resolved Open Question 1 above, a `pending_approval`/unassigned device's connection
  is refused outright, it never completes the handshake.**
- `apps/chrono-api/src/app.ts` — mount the device realtime route at
  `/api/v1/device/ws`, **outside** `/rpc` and `tenantMiddleware()`, alongside the
  existing `deviceAuthRoutes()` mount — confirm it is mounted before the
  `maintenanceReadOnlyGate` `.use()` call (the plan's explicit, intentional bypass —
  do not move it after that gate).
- `apps/chrono-api/src/modules/device/routes.ts` — the existing revoke/unapprove/relink
  handlers call `closeConnections({ actorKey: deviceId })` (from `agora/realtime`) after
  their DB write, so a revoked device's live socket closes immediately rather than
  waiting for the next `revalidateEveryMs` tick.
- `apps/chrono-api/src/modules/session/service.ts` (touched again) — the same
  `session.state` publish Phase 2b added also targets the device's own private channel
  `tenant:{t}:device:{deviceId}` when the affected station has an approved device
  linked (look up `chronoDevice` by `stationId` inside the same publish call).

**Step-by-step tasks**
1. Build the device `resolveActor`, reusing `device-auth-middleware.ts`'s credential
   check rather than duplicating it.
2. Mount `/api/v1/device/ws` with `limits: { maxLifetimeMs: 12 * 60 * 60 * 1000,
   revalidateEveryMs: 5 * 60 * 1000, heartbeatMs: 30_000, maxPerActor: 2,
   requireOrigin: false, ... }` per the "Station/device channel" section's exact
   numbers above.
3. Wire heartbeat-driven `connectivityStatus`/`lastSeenAt` updates on each ping,
   superseding the REST heartbeat while the socket is up (REST heartbeat stays for
   devices that can't hold a socket — no removal).
4. Add the inbound-frame hardening: drop any frame whose `stationId`/`deviceId` doesn't
   match the connection's own resolved identity.
5. Wire `closeConnections` into revoke/unapprove/relink.
6. Extend the `session.state` publish to also target the device's private channel.

**Acceptance criteria**
- A device with a valid, `approved` credential connects and receives `session.state`
  events for its own station only.
- A `pending_approval` device's connection attempt fails before the handshake completes
  (401/403, matching the REST middleware's own indistinguishable-error convention).
- Revoking a device while its socket is open closes that socket within the same
  request (assert via `channelCount()`/an open-connections helper going to zero for
  that actor, not just "no more events arrive").
- A device frame naming another device's `deviceId` is dropped, never relayed.
- The maintenance gate does not disconnect an open device socket during a maintenance
  window (confirm the mount order in `app.ts`, and/or a focused test toggling
  maintenance mode with a device socket already open).

**Verification commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-scope:** remote commands (lock/unlock/restart) — deferred to its own plan, per
"Remote commands — deferred, not designed here" above; do not design or stub a command
vocabulary in this phase.

**Execution start point:** `apps/chrono-api/src/modules/device/realtime-actor.ts`.

---

## Phase 4 — E2E spec

**Files to update**
- `apps/chrono-web/e2e/tests/realtime/station-updates.spec.ts` (new)
- `apps/chrono-web/e2e/tests/realtime/device-channel.spec.ts` (new)

**Step-by-step tasks**
1. Happy path: staff subscribes to `branch:{id}`, a station update (via the real
   dashboard flow) delivers a `station.status` event to that subscriber with no reload.
2. Cross-tenant isolation: tenant B's staff, subscribed to its own branch, receives
   nothing from tenant A's station updates.
3. Device-channel isolation: device A's socket receives nothing addressed to device B
   (publish a `session.state` event scoped to device B's station, assert device A's
   socket stays silent).
4. Role-gate leg — since subscribing has **no** permission gate by design, this is
   satisfied by two assertions instead of one "member vs staff" case: (a) the *device*
   gate — a non-`approved` device's connection attempt is refused 403; (b) the
   *producing mutation's* own existing gate — a session without `station:update` cannot
   trigger the station-update publish in the first place (this is already covered by
   `station`'s own existing permission tests; this spec only needs to confirm the
   publish path is reachable through the real gated route, not re-test the gate itself).

**Acceptance criteria**
- All four scenarios pass, mirroring `apps/agora-web/e2e/tests/realtime/
  connection-auth.spec.ts`'s pattern (real WS in `page.evaluate`, or `connectRealtime()`
  directly) and the foundation plan's own subprocess-isolated test-publish approach —
  do not add a new test-publish HTTP route; reuse or extend the existing
  `realtime-test-publish` helper pattern for Chrono's own event types.

**Verification commands**
- `pnpm --filter @agora/chrono-web typecheck`
- The new Playwright specs (manual run per `.ai/rules/rbac.md`'s browser-coverage note —
  headed, needs `pnpm dev` running, no `apps/chrono-api/.env` present).

**Out-of-scope:** load/perf testing of the realtime path; remote commands.

**Execution start point:** copy `apps/agora-web/e2e/tests/realtime/connection-auth.spec.ts`'s
structure and subprocess test-publish helper as the fixture, adapting for Chrono's own
event types and the two spec files above.
