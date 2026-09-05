# Chrono — `app-usage` module

**Blocked on:** the same missing prerequisites as `app-versions`
(`.ai/plans/chrono/blocked/app-versions/README.md`), plus one additional hard
dependency: this feature's only ingestion path is device-bearer-authenticated telemetry
from a running PC-client, and neither the device-auth mechanism nor the PC-client exist
in this workspace. Filed to `.ai/plans/chrono/blocked/` per the same
`.ai/rules/feature-planning.md` category as `app-versions` — blocked by fact, not
deferred by choice.

## What this is (deferred scope)

Per-station telemetry of what's running on a paired kiosk PC — launch/close events for
named applications, with lightweight resource metadata (CPU/memory) — so staff/ops can
see live "what's this station running right now" and detect unauthorized software.

---

## Pass 1 — Workflow Analysis (of the eventual feature, not of what's buildable now)

**Who uses it:** the PC-client agent running on a paired station is the sole writer
(machine identity, not a human session). A tenant `staff`/`admin` is the reader, viewing
"what's currently running" per station from the Chrono dashboard.

**Workflow:** the PC-client watches OS process launch/close events and posts a batch to
the API keyed by its own device identity; a staff dashboard page polls "current running
apps for station X" to flag unexpected software during a session.

**Failure cases:** a device posting telemetry for a station it isn't paired to must be
rejected (device-auth must resolve `stationId` server-side from the device's own
identity, never trust a client-supplied `stationId`); telemetry volume must be bounded
(this is a candidate for real backpressure/rate-limiting given it's a hot per-process
event stream, not a normal `/rpc` mutation); an offline device replaying a backlog of
events must not double-count or corrupt ordering.

**Audit / notifications:** none identified yet beyond the raw event log itself — no
tenant-facing alerting is implied by oikos's shape (its own `GET /current/:stationId`
was still a stub returning `[]`), so even in oikos this was unfinished.

---

## Pass 2 — Technical Planning: why this is BLOCKED, not just deferred

### Verbatim source of the "eventually" language

Same `apps/chrono-api/AGENTS.md` passage quoted in `app-versions`' plan applies here
too — `app-usage` is listed in the same "Deferred… not planned until Wave 1 is proven"
sentence, and it depends on the same device pairing/bearer-auth line the AGENTS.md file
calls out as the one thing still owed to the (not-yet-ported) PC-client apps.

### Prior-art shape (oikos, reference only)

`apps/chrono-api/src/modules/app-usage/routes.ts`: `POST /events` is gated by
`requireDeviceAuth` (a device bearer-token check, structurally distinct from any human
session/tenant-membership check) and ingests `launched`/`closed` telemetry arrays into an
`AppUsageEvent` table (`eventType`, `appName`, `executablePath`, `metadataJson: {cpu,
memory}`). `GET /current/:stationId` was **left as a stub returning `[]`** even in the
donor codebase — i.e. oikos itself never finished the read side of this feature. This is
a strictly stronger blocking case than `app-versions`: not only is the consumer/producer
infrastructure unbuilt here, the reference implementation for the one route that would
prove the design out was never completed either.

### Why this cannot be planned right now — same three gaps as `app-versions`, plus one more

1. **No device identity/bearer-auth exists** (`devices` module: contracts only). This is
   `app-usage`'s *entire* write path — unlike `app-versions`, which has a plausible
   platform-admin-only write path independent of devices, `app-usage` has **no** write
   path that doesn't require device auth. There is nothing to build here at all until
   `devices` Phase 1+3 (schema, then the bearer-auth middleware itself) land — the
   migration handover explicitly flags that middleware as "genuinely novel — review
   before Phase 3, not a rubber-stamp open question," underlining that it is real,
   unstarted design work, not a formality.
2. **No PC-client producer exists** (`apps/chrono-pc-client`, out of scope for this
   pass) — identical gap to `app-versions`.
3. **No `sessions`/`stations` runtime context to correlate telemetry against yet in a
   settled way** — `sessions` schema (Phase 1) hasn't landed either (only `contracts.ts`
   exists per the migration handover), and a "what's running on this station right now"
   feature is naturally framed relative to the active session on that station. Planning
   `app-usage`'s data model ahead of `sessions`' actual schema risks the same
   guess-then-rewrite problem called out in `app-versions`.
4. **Genuinely open volume/scoping question, unlike `app-versions`**: process-launch
   telemetry is a much higher-volume write pattern than an occasional version-check —
   before this is planned, the developer needs to decide whether it is even in scope for
   Agora's Chrono port at all (per-tenant business value vs. operational/security
   tooling that may not need a full tenant-scoped table + RLS treatment the way
   `project`-shaped resources do), which is a product decision, not something inferable
   from the code alone.

### Unblocking condition

Re-open this plan once **all** of:
1. `devices` module ships both schema (Phase 1) and the bearer-auth middleware (its own
   later phase) — not just contracts.
2. `sessions` module ships its schema, so telemetry can be correlated against a real
   session/station model instead of a guess.
3. The developer confirms `app-usage` is still wanted at all for the Agora port (given
   oikos itself never finished its read side) and, if so, whether it should be scoped
   down from "full process-launch/close telemetry" to something narrower for a first
   cut.

---

## Out of Scope (this plan, as filed)

Everything — same reasoning as `app-versions`: no schema/contracts/routes/UI are
proposed because the shapes are not yet knowable, and here the case for waiting is
stronger (zero viable write path exists today, not merely an under-specified one).

---

## Open Questions (developer to confirm/override)

1. Is `app-usage` (process-level telemetry) actually wanted for the Agora-based Chrono,
   or was it a diagnostic/support tool in oikos that doesn't need to survive the port?
   Worth deciding before `devices`/`sessions` land, so this doesn't silently become
   "blocked forever" without anyone noticing it should instead move to
   `.ai/plans/chrono/future/` (deferred by choice) or be dropped from the deferred list
   entirely.
2. If kept, should the write path require full device bearer-auth (oikos's model) or
   could a first cut ride on the `sessions` module's own device-facing surface once that
   exists, avoiding a second parallel auth integration?
3. What retention/volume policy is expected for `AppUsageEvent`-equivalent rows — this
   materially affects whether it should be a normal RLS-forced Postgres table at all
   versus something with its own pruning/partitioning story, which should be decided
   before Phase 1 of a future plan, not discovered after.

---

## After Implementation

Not applicable — this plan is not implementation-ready. When the unblocking conditions
are met, write a fresh Pass 1/Pass 2/phased plan against the real `devices` and
`sessions` schemas and file it under `.ai/plans/chrono/draft/app-usage/README.md`, then
update `.ai/handover/chrono-migration.md`'s deferred-modules table accordingly.
