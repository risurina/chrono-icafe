# Chrono — `sessions` module

**Depends on:** `stations` (done, committed `557b43e`, not implemented) — a session runs
on a `ChronoStations` row and consults its `ChronoStationGroups.hourlyRate`/
`memberRate`. `members` (done, committed `00ef2aa`, not implemented) — a session belongs
to a `tenantMember`, and its rate optionally depends on `ChronoMemberProfiles.
applicationStatus`. `wallet` (done, committed `34c4457`, not implemented) — a session's
final billing debit calls the exported `debitWallet(tx, {...})` helper inside its own
`withTenant` transaction, never a hand-rolled wallet mutation. **This is the last Wave-1
module** — nothing in the dependency graph depends on `sessions`.

All three dependencies exist today only as committed *plans*, not code (only `branches`
has landed schema on disk, `apps/chrono-api/src/modules/branch/{schema,contracts}.ts`;
`station`/`member`/`wallet` module folders don't exist yet). This plan is written against
those plans' documented shapes and cites them by file/section throughout — the
implementor builds this module after (or alongside, if working strictly phase-by-phase)
`stations`/`members`/`wallet` land the specific tables/helpers referenced below.

## What this is

Sessions are timed gaming-station usage: a customer sits at a station, staff starts a
session (optionally with a duration), the station shows occupied, and closing the
session computes elapsed time × the station's rate and debits the customer's wallet.
This plan covers the **session entity and its billing/lifecycle** — not device pairing/
unlock signals (`devices`' concern, touchpoint noted only), not a live-updating
websocket board (no realtime infrastructure exists in agora today — deferred, see
below), and not the lot-based time-credit fallback (`wallet`'s own "Critical scope
finding" already cut that as a separate, larger, `stations`-dependent system).

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff / Admin / Owner** — starts a session (pick an available station + a customer,
  optionally a duration), pauses/resumes it, extends the scheduled end time, and ends it
  (final billing). This is routine floor management — the single most frequent action at
  a gaming café — so, matching oikos's own gate (`requireAuth` with no branch-role
  split anywhere in `modules/sessions/routes.ts`), **staff holds the full lifecycle**,
  not a restricted subset. See "Permission vocabulary" below for why this plan, unlike
  every prior Chrono plan, has no staff-denied action on this resource.
- **Customer (portal)** — views their own currently-running session (station, elapsed/
  remaining time, live-computed cost-so-far is NOT shown — see Out of Scope) from
  `/portal`, read-only. No self-service start/end in this pass (matches every prior
  Chrono module's staff-driven-counter workflow; oikos's own customer-facing surface for
  this is the deferred `chrono-pc-client` kiosk app, out of scope for the whole
  migration per `.ai/handover/chrono-migration.md`).
- **Platform admin (`/rpc-admin`)** — not built in this pass, same as every prior module.

**Workflow:** Staff opens **Dashboard → Sessions**, sees an Active Sessions board
(stations currently running, filterable by branch), clicks **Start Session**, picks an
`available` station and a customer, optionally sets a duration, confirms — the station
flips to `occupied` and a countdown (if timed) starts. Staff can **Pause** (customer
steps away, time stops accruing), **Resume**, **Extend** (add minutes), and **End**
(customer is done — computes the final charge, debits the wallet, frees the station).
An open-ended (no duration) session runs until manually ended. A timed session past its
scheduled end is auto-closed by a background sweep (see "Background sweep" below) with
the exact same billing code path as a manual end.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Starting a session on a station that is not `available` (`occupied`/`maintenance`/
  `offline`) → **409** `STATION_NOT_AVAILABLE`.
- Starting a session on a station with no `stationGroupId` → **400** — there is no rate
  to bill against (this plan does not invent a per-session rate override; see "Rate
  resolution" below).
- Starting a session for a customer with a non-`active` `tenantMember.status`
  (suspended) → **409**.
- Starting a session for a customer with a zero-or-negative wallet balance → **422**
  `Insufficient wallet balance to start a session.` (an advisory pre-check — the actual
  balance can still move between start and end since nothing else in Wave 1 writes wallet
  debits concurrently within a session's lifetime; this is not a hold/reservation).
- Two staff starting a session on the same station at once → the DB-level partial unique
  index catches the race (see Schema) → the loser gets **409** `STATION_OCCUPIED`, never
  a duplicate row.
- Pause/resume/extend/end on a `sessionId` that doesn't belong to the caller's tenant →
  **404**, never 403 (no existence leak — RLS + explicit tenant-scoped lookup inside
  `withTenant`).
- Pause on an already-paused or already-ended session, resume on a non-paused session,
  end on an already-ended session → **409** `SESSION_NOT_ACTIVE`-shaped message (state
  machine violation), **except** a concurrent double-end (manual end racing the expiry
  sweep) is **not** an error — see "Concurrency — end is idempotent" below.
- **Tenant-isolation leak scenario**: tenant A starts a session on its own station for
  its own customer; tenant B's `/dashboard/sessions` list must never show that row (RLS
  is the primary guarantee, `rls:proof` exercises the generic mechanism), and tenant B
  staff hitting tenant A's `sessionId` directly on any lifecycle route gets 404. A
  session started with a `stationId`/`memberId` belonging to a **different** tenant than
  the caller's must be rejected the same way `wallet`'s Pass 1 describes for
  `memberId` — the route looks up both inside the caller's own `withTenant` transaction
  (RLS-scoped), so a foreign-tenant id is simply Not Found, never silently accepted.
- **Concurrency — end is idempotent, the core hazard this plan must close**: the
  background expiry sweep and a manual `POST /:id/end` can race on the same session (a
  customer walks up to end their own timed-out session at the front desk in the same
  second the sweep ticks). The close operation claims the row with an atomic
  `UPDATE ... WHERE status IN ('active','paused') RETURNING *` — the loser of the race
  updates zero rows and returns the **already-closed** row instead of erroring or
  double-billing. This is the same atomic-claim shape `wallet`'s row-lock section and
  oikos's own `endSession` both rely on; see "Session close (the load-bearing service
  function)" below — proven by a concurrency test in Phase 3, not just asserted in
  prose.
- Stale screen: two staff viewing the same session — last write wins on non-billing
  fields (matches `branches`/`stations`/`members`' own precedent); the billing write
  itself is protected by the atomic claim above, not by staleness detection.

**Audit / notifications:** every start/pause/resume/extend/end writes a
`recordStaffAudit` entry (`session.started` / `.paused` / `.resumed` / `.extended` /
`.ended`) — the `.ended` entry's `metadata` carries `{finalAmount, amountCharged,
shortfallAmount}` so a financially-relevant closure is auditable without a second,
bespoke per-session event table (see "Deliberately narrowed" below for why oikos's
`DeviceSessionEvents` table is not ported). No transactional email in this pass, matching
every prior module's "not required to ship the workflow" call.

---

## Pass 2 — Technical Planning

### Critical scope finding — this plan is a deliberately simplified billing model, not a port (read before the schema)

Research against oikos (`C:\Users\ronni\project\izur\oikos`,
`apps/chrono-api/src/database/schema/device-sessions.ts` +
`apps/chrono-api/src/modules/sessions/{service,billing.service,pricing-resolver,
member-balance}.ts`) confirms oikos's actual model, and why this plan narrows it:

- **oikos's real model**: prepaid-tick, metered-elapsed-time billing. `billSessionUsage()`
  computes elapsed minutes since the last watermark event (start/tick/end) and charges
  incrementally at **three** points — session start (a configurable "login minimum"
  charge, from a `Setting` row this codebase has no equivalent of), pause (bills the
  pre-pause segment), and end (final charge). The rate is resolved by `pricing-resolver.
  ts` from `PricingRule` (day/time windows, membership tier, device-group specificity
  scoring) and frozen into a `pricingSnapshotJson` at start. Billing charges **wallet
  cash first, then falls through to time-credit `CreditGrants`** for any shortfall
  (`credit-application.service.ts`), and an insufficient-balance shortfall is reported,
  not rolled back — the partial charge stands.
- **Why this plan does not port that whole**: `stations`' own plan already cut the
  `PricingRule` engine down to a flat `hourlyRate`/`memberRate` per station group (its
  own Open Question 3), and `wallet`'s own plan already cut the entire lot-based
  `CreditGrants` credit system as a separate, `stations`-dependent module not in Wave 1
  (its own "Critical scope finding"). Porting oikos's multi-checkpoint ticking and
  credit-fallback logic here would resurrect exactly the systems those two plans
  deliberately deferred — this plan inherits their cuts rather than re-litigating them.
- **What this plan builds instead**: a **single final debit at close** (not
  start-tick-pause-tick-end-tick), against a **frozen flat rate** (station group's
  `hourlyRate`/`memberRate`, no day/time/promo resolution), against **wallet cash
  only** (no credit-grant fallback — a shortfall is capped and recorded, not partially
  drawn from a second balance system that doesn't exist yet in this codebase). This is
  materially simpler than oikos and is flagged prominently as **Open Question 1** below
  — confirm this is the right level of fidelity for Wave 1 before Phase 3.

### Rate resolution (flat, frozen at start — no `PricingRule` engine)

A station must belong to a `ChronoStationGroups` row to be billed (per `stations`'
Pass 2, `hourlyRate` lives only on the group, not the station). At session start:

- `rate = memberRate` if the group has one set **and** the customer holds a
  `ChronoMemberProfiles` row with `applicationStatus === "approved"` (members' own
  "Enforcement note" flagged that nothing yet reads `applicationStatus` to gate
  anything — this is exactly the first real consumer it anticipated).
- Else `rate = hourlyRate`.
- If the station's `stationGroupId` is null, the route rejects the start with **400**
  (`"This station has no pricing group — assign one in Stations → Groups & Rates before
  starting a session."`) rather than inventing a per-session rate override field that
  would duplicate the group's own `hourlyRate`, keeping a station's rate single-sourced.

The resolved rate is frozen into `ChronoSessions.rateSnapshot` (+ `rateSource`,
`"group_member" | "group_hourly"`) at start — immune to a mid-session edit of the
group's rate, matching oikos's own snapshot pattern and `stations`' own "frozen rate"
precedent language.

### Session close (the load-bearing service function)

One function, `closeSession(tx, { tenantId, sessionId, performedByUserId })` in
`apps/chrono-api/src/modules/session/service.ts`, is the **only** code path that ends a
session — called by both the manual `POST /:id/end` route and the background expiry
sweep, so there is exactly one implementation of the billing-closure logic (mirrors
oikos's own single `endSession` reused by its expiry job, and mirrors this codebase's
own principle of one code path per money-moving operation):

```ts
export async function closeSession(
  tx: TenantTx,
  args: { tenantId: string; sessionId: string; performedByUserId: string | null },
): Promise<{ session: ChronoSessionRow; alreadyClosed: boolean }> {
  const now = new Date();
  // Atomic claim: only a row still IN ('active','paused') is claimable. A racing
  // caller (manual end vs. expiry sweep) that loses this race updates zero rows.
  const [claimed] = await tx
    .update(chronoSession)
    .set({ status: "closing_marker_unused" /* see note below */ })
    .where(
      and(
        eq(chronoSession.id, args.sessionId),
        eq(chronoSession.tenantId, args.tenantId),
        inArray(chronoSession.status, ["active", "paused"]),
      ),
    )
    .returning();
  if (!claimed) {
    const [existing] = await tx
      .select()
      .from(chronoSession)
      .where(eq(chronoSession.id, args.sessionId))
      .limit(1);
    if (!existing) throw new HttpError(404, "Session not found.");
    return { session: existing, alreadyClosed: true };
  }

  // Billable seconds = wall-clock elapsed since start, minus accumulated paused
  // time, minus the still-open pause segment if closing while paused.
  const pausedNow = claimed.status === "paused" && claimed.pausedAt
    ? Math.floor((now.getTime() - claimed.pausedAt.getTime()) / 1000)
    : 0;
  const billableSeconds = Math.max(
    0,
    Math.floor((now.getTime() - claimed.startedAt.getTime()) / 1000) -
      claimed.pausedDurationSeconds -
      pausedNow,
  );
  const finalAmount = computeMeteredCharge(billableSeconds, claimed.rateSnapshot);

  const [wallet] = await tx
    .select({ balance: chronoWallet.balance })
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, claimed.memberId));
  const walletBalance = wallet?.balance ?? "0.00";
  const amountCharged = capMoney(finalAmount, walletBalance); // min(finalAmount, max(balance, 0))

  let walletTransactionId: string | null = null;
  if (Number(amountCharged) > 0) {
    const { transaction } = await debitWallet(tx, {
      tenantId: args.tenantId,
      memberId: claimed.memberId,
      amount: amountCharged,
      reason: `Session ${claimed.id}`,
      referenceType: "session",
      referenceId: claimed.id,
      performedByUserId: args.performedByUserId ?? undefined,
    });
    walletTransactionId = transaction.id;
  }

  const [session] = await tx
    .update(chronoSession)
    .set({
      status: "ended",
      endedAt: now,
      actualBillableSeconds: billableSeconds,
      finalAmount,
      amountCharged,
      walletTransactionId,
      updatedAt: now,
    })
    .where(eq(chronoSession.id, claimed.id))
    .returning();

  await tx
    .update(chronoStation)
    .set({ status: "available", updatedAt: now })
    .where(eq(chronoStation.id, claimed.stationId));

  return { session: session!, alreadyClosed: false };
}
```

(The pseudo-status `"closing_marker_unused"` above is illustrative of "claim it
somehow atomically" — the real implementation claims by updating straight to `"ended"`
plus every final-state column in the **same** `UPDATE ... WHERE status IN (...)
RETURNING *`, since there is no intermediate "closing" status in the schema. Phase 3
writes the real single-statement version; this section specifies the *sequencing and
atomicity requirement*, not literal executable code.)

**Why `debitWallet` never throws 422 here**: `amountCharged` is computed as
`min(finalAmount, currentBalance)` *before* calling `debitWallet`, so the debit can
never drive the balance negative — `wallet`'s own insufficient-balance guard is
structurally unreachable from this call site. This is a deliberate difference from
every other `debitWallet` call site in the codebase (which expect the guard to fire and
propagate a 422) — **Open Question 2** below asks the developer to confirm this
"cap-and-record-shortfall" behavior instead of oikos's own credit-grant fallback.

**Money math**: `apps/chrono-api/src/modules/session/money.ts` (session-local, imports
`toCents`/`fromCents` from `../wallet/money` — a peer-module import, same pattern
`stations` used importing `chronoBranch` from `../branch/schema`): `computeMeteredCharge
(billableSeconds: number, ratePerHour: string): string` computes
`round(ratePerHour_cents * billableSeconds / 3600)` in BigInt (round-half-up: add
`1800n` — half of `3600n` — before integer division, never `Number()`/float math on a
money value, per `.ai/rules/database.md`), and `capMoney(amount: string, ceiling:
string): string` returns the lesser of two non-negative decimal strings, also
BigInt-cents, never comparing/subtracting via `Number()`.

### What exists today in oikos — routes, realtime, jobs, web UI (source of truth)

- **Routes** (`apps/chrono-api/src/modules/sessions/routes.ts`): `GET /active` (caller's
  own active session, member-scoped), `GET /` (list), `POST /` (start), `POST /:id/end`,
  `POST /:id/extend` (`{minutes}`), `POST /:id/pause` (`{reason?}`), `POST /:id/resume`,
  `POST /:id/away-lock`/`/away-unlock` (player AFK self-lock), `POST
  /:id/staff-override-away-unlock`, `POST /:id/transfer` (move to another station). This
  plan ports `list`/`start`/`end`/`pause`/`resume`/`extend` and a portal `active`
  equivalent; away-lock/unlock/staff-override/transfer are hardware- or
  kiosk-client-coupled and cut (see Out of Scope).
- **Schema** (`apps/chrono-api/src/database/schema/device-sessions.ts`):
  `DeviceSessions` (status enum `ACTIVE/PAUSED/ENDED/AWAY_LOCKED`, mode enum
  `PREPAID/POSTPAID`, `scheduledEndAt` nullable = open-ended, a **partial unique index
  `(tenantId, stationId) WHERE status='ACTIVE'`** enforcing one active session per
  station at the DB level, `pricingSnapshotJson`/`priceSnapshot`) plus a separate
  `DeviceSessionEvents` audit trail and `AppUsageEvents` telemetry table — **neither of
  the latter two is ported** (see "Deliberately narrowed").
- **Realtime** (`apps/chrono-api/src/realtime/socket.ts`): Socket.IO v4, rooms per
  tenant/branch/station, a `station-update` broadcast on status change. Confirmed **not**
  load-bearing for correctness — every `emitDeviceCommand`/socket call in `service.ts` is
  wrapped in try/catch and only logged on failure; the web client's own
  `station-grid-client.tsx` runs an **independent reconciliation poll**
  (`setInterval`) *alongside* its socket subscription specifically to correct for
  dropped realtime events, and the countdown timer itself is client-computed from
  `scheduledEndAt`, not server-pushed ticks. This confirms REST + poll is a complete,
  correct substitute for Wave 1.
- **Background jobs** (`apps/chrono-api/src/jobs/{session-expiry,session-warnings}.ts`):
  plain `setInterval(fn, 60000)` per job (no cron/queue library) via a hand-rolled
  `jobs/index.ts#startJobs()`. `session-expiry` auto-closes `ACTIVE` sessions past
  `scheduledEndAt`. `session-warnings` sends a `SHOW_MESSAGE` device command at
  10/5/1-minute thresholds — this is a kiosk-UI feature with **no receiving client in
  this migration** (`chrono-pc-client` is out of scope for the entire migration per
  `.ai/handover/chrono-migration.md`), so it is cut entirely, not just deferred (see Out
  of Scope) — there is nothing on the other end to warn.
- **Web UI**: `apps/chrono-web/src/lib/tenant-ops.ts` doesn't exist in this repo yet
  (confirmed — `apps/chrono-web/src/lib/` currently holds only foundation-inherited
  files: `auth-client.ts`, `member-client.ts`, `rpc.ts`, etc.). oikos's live board is
  `station-grid-client.tsx`: a socket-subscribed + poll-backstopped grid with a
  client-ticking countdown per occupied station, pause/resume/extend/transfer actions in
  a dialog.

### Background sweep — built on agora's proven periodic-sweep pattern, not a new one

Checked (per this task's explicit instruction) whether agora has any job-scheduling
mechanism before assuming one could be built fresh:

- **`agora/queue`** (`packages/agora/src/queue/`) exists and is real, Postgres-backed
  infrastructure (`registerJob`/`dispatch`/`startQueueWorker`, used today for email/SMS/
  webhook delivery, `apps/agora-api/src/index.ts`). It is a **one-off dispatched job**
  model (each `dispatch()` call enqueues a single row consumed once) — the right shape
  for "send this one webhook," the wrong shape for "scan a table for rows matching a
  time condition, repeatedly, forever."
- **`packages/agora/src/server/retention.ts`** is the exact right precedent instead: a
  **recurring table-scan sweep** — `runRetentionSweepOnce()` (a plain async function,
  directly callable, used by tests) wrapped by `startRetentionWorker()` (a
  `setInterval` + `.unref()` poller, env-configurable interval, started once from
  `apps/agora-api/src/index.ts` alongside the `startQueueWorker(...)` calls, with a
  matching `stopRetentionWorker()` wired into the `SIGINT`/`SIGTERM` handler).

This plan's `session-expiry` sweep is architecturally identical to `retention.ts`, not a
new pattern: `runSessionExpirySweepOnce()` / `startSessionExpiryWorker()` in
`apps/chrono-api/src/modules/session/expiry.ts`, wired into `apps/chrono-api/src/
index.ts` the same way. `session-warnings` has no equivalent here (see above — cut, not
ported).

**Sweep mechanics**: `ChronoSessions` is RLS-forced (in `APP_TENANT_TABLES`), so a
cross-tenant scan cannot use a bare `adminDb` query. The sweep reads due rows via
`withAdmin` (RLS-bypassing, read-only — same pattern `retention.ts` itself uses for its
own cross-tenant prune queries), then closes each one via `withTenant(row.tenantId, tx =>
closeSession(tx, { tenantId: row.tenantId, sessionId: row.id, performedByUserId: null
}))` — one RLS-scoped transaction per session, reusing the exact same `closeSession`
the manual route calls, so a sweep-closed session is byte-for-byte the same billing
outcome as a staff-closed one.

```ts
// apps/chrono-api/src/modules/session/expiry.ts
export async function runSessionExpirySweepOnce(): Promise<{ closed: number }> {
  const due = await withAdmin((tx) =>
    tx
      .select({ id: chronoSession.id, tenantId: chronoSession.tenantId })
      .from(chronoSession)
      .where(
        and(
          inArray(chronoSession.status, ["active", "paused"]),
          isNotNull(chronoSession.scheduledEndAt),
          lt(chronoSession.scheduledEndAt, new Date()),
        ),
      )
      .limit(200), // same batch cap oikos itself used
  );
  let closed = 0;
  for (const row of due) {
    await withTenant(row.tenantId, (tx) =>
      closeSession(tx, { tenantId: row.tenantId, sessionId: row.id, performedByUserId: null }),
    );
    closed++;
  }
  return { closed };
}

const SESSION_EXPIRY_SWEEP_INTERVAL_MS =
  Number(process.env.SESSION_EXPIRY_SWEEP_INTERVAL_MS) || 60_000; // matches oikos's 60s cadence

export function startSessionExpiryWorker(): () => void {
  const timer = setInterval(() => {
    runSessionExpirySweepOnce().catch((err) => {
      logger.error({ msg: "session expiry sweep failed", error: String(err) });
    });
  }, SESSION_EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

An open-ended session (`scheduledEndAt: null`) is never touched by the sweep — matches
oikos's own `WHERE scheduledEndAt < now` filter (a null never satisfies `<`), and
matches this plan's own "open-ended runs until manually ended" workflow rule.

### Realtime — no infrastructure exists; explicitly deferred, not silently dropped

Confirmed (per this task's explicit instruction) via a repo-wide check: **no
`socket.io`, `ws`, Server-Sent Events, or any websocket setup exists anywhere** in
`packages/agora` or any app's `package.json`/source. The dashboard notification bell
(`packages/agora/src/ui/components/custom/notification-bell.tsx`) — the one existing
"live-ish" UI in this codebase — is itself poll-only (`setInterval`). Combined with the
oikos finding above (sockets there are a non-load-bearing UX layer over a REST/poll
source of truth), this plan ships the Active Sessions board as **plain polling**
(client-side `setInterval` refetch, e.g. every 10–15s, plus a purely client-computed
countdown ticking every second from `scheduledEndAt` — no server push needed for a
ticking display).

**Building Socket.IO (or any realtime transport) is explicitly out of scope for this
plan** — introducing it is a foundation-level decision (new dependency, new server
wiring, a new auth-in-handshake pattern, its own plan) and must not happen as a side
effect of shipping sessions. Naming it so it is tracked, not lost: **`chrono-realtime-
updates`** — a future, separate, `agora`-scoped-or-Chrono-scoped plan the developer can
schedule once polling proves too coarse in practice.

### Deliberately narrowed from oikos (and why)

- **No `DeviceSessionEvents` table.** oikos's per-session audit trail is fully
  subsumed by this codebase's existing `recordStaffAudit` tenant audit log (every
  lifecycle transition already writes one `session.*` entry there) — a second, parallel
  event table would duplicate that without a distinct consumer, the same call `wallet`
  made not adding a second suspension flag and `members` made not adding a second
  `memberCode`.
- **No `AppUsageEvents` telemetry.** Per-app foreground-usage tracking from a PC client
  that doesn't exist in this migration (`chrono-pc-client` out of scope entirely).
- **No `PREPAID`/`POSTPAID` mode column.** A vestige of oikos's login-minimum-charge
  design this plan doesn't port (see "Critical scope finding") — there is only one
  billing model here.
- **No away-lock/staff-override-away-unlock.** Player AFK self-lock is a kiosk-client +
  device-command feature; neither exists in this pass.
- **No transfer-to-another-station.** A real oikos feature with no strong Wave-1 need
  and real complexity (must unlock the old station, lock the new one, preserve billing
  continuity) — cut, not silently forgotten (see Out of Scope).
- **No session-warnings job.** See "What exists today" above — no client exists to
  receive the warning in this migration pass.

### Schema — `ChronoSessions`

New file `apps/chrono-api/src/modules/session/schema.ts`:

```ts
import { pgTable, text, timestamp, integer, numeric, index, uniqueIndex, sql } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoWalletTransaction } from "../wallet/schema";

export const chronoSession = pgTable(
  "ChronoSessions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Denormalized from the station at start, for query/filter convenience —
    // mirrors oikos's own DeviceSessions.branchId. Immutable after start.
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // restrict, not cascade: a station with ANY session history (even ended)
    // must not be deletable out from under its own billing records. See Open
    // Question 4 — stations' own DELETE route needs a follow-up to catch this.
    stationId: text("stationId")
      .notNull()
      .references(() => chronoStation.id, { onDelete: "restrict" }),
    // cascade: matches wallet's own ChronoWalletTransactions choice — deleting
    // a customer (DSAR) also removes their session history, the same
    // trade-off wallet already accepted for financial ledger rows.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    startedByUserId: text("startedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"), // "active" | "paused" | "ended"
    startedAt: timestamp("startedAt").notNull().defaultNow(),
    // Null = open-ended, closed only by an explicit end (never touched by the
    // expiry sweep).
    scheduledEndAt: timestamp("scheduledEndAt"),
    pausedAt: timestamp("pausedAt"),
    pausedDurationSeconds: integer("pausedDurationSeconds").notNull().default(0),
    endedAt: timestamp("endedAt"),
    actualBillableSeconds: integer("actualBillableSeconds"),
    // Frozen at start — immune to a later edit of the group's rate.
    rateSnapshot: numeric("rateSnapshot", { precision: 12, scale: 2 }).notNull(),
    rateSource: text("rateSource").notNull(), // "group_hourly" | "group_member"
    currency: text("currency").notNull().default("PHP"),
    // Full computed cost vs. what was actually debited (capped at the wallet
    // balance at close time) — see "Session close" in Pass 2.
    finalAmount: numeric("finalAmount", { precision: 12, scale: 2 }),
    amountCharged: numeric("amountCharged", { precision: 12, scale: 2 }),
    walletTransactionId: text("walletTransactionId").references(
      () => chronoWalletTransaction.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_session_tenant_idx").on(t.tenantId),
    index("chrono_session_branch_idx").on(t.branchId),
    index("chrono_session_station_idx").on(t.stationId),
    index("chrono_session_member_idx").on(t.memberId),
    index("chrono_session_status_idx").on(t.status),
    index("chrono_session_scheduled_end_idx").on(t.scheduledEndAt),
    // One non-ended session per station at the DB level — mirrors oikos's own
    // partial unique index, extended to cover PAUSED (a paused session still
    // owns its station; oikos's own station.status already read "occupied"
    // through a pause too).
    uniqueIndex("chrono_session_active_per_station_uq")
      .on(t.tenantId, t.stationId)
      .where(sql`${t.status} in ('active','paused')`),
  ],
);
```

`finalAmount`/`amountCharged`/`walletTransactionId`/`endedAt`/`actualBillableSeconds`
are all null until the session ends — a running session has no computed cost stored
(the UI computes an approximate live estimate client-side from `rateSnapshot` ×
elapsed-so-far, purely presentational, never trusted as the billing figure).

### `APP_TENANT_TABLES`

Add `"ChronoSessions"` to the array in `apps/chrono-api/src/db/schema.ts` (alongside
whatever `stations`/`members`/`wallet` have already added — check the file's current
state first; don't clobber a concurrently-landed entry), and re-export `chronoSession`
from the module, mirroring `chronoBranch`'s existing re-export exactly.

### Contracts — `apps/chrono-api/src/modules/session/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const sessionStatusSchema = z.enum(["active", "paused", "ended"]);

export const startSessionSchema = z.object({
  stationId: z.string().min(1),
  memberId: z.string().min(1),
  durationMinutes: z.number().int().positive().max(1440).optional(), // omit = open-ended
});

export const extendSessionSchema = z.object({
  minutes: z.number().int().positive().max(1440),
});

export const sessionListQuerySchema = listQuerySchema([
  "startedAt",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
  stationId: z.string().optional(),
  memberId: z.string().optional(),
  status: sessionStatusSchema.optional(),
});

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type ExtendSessionInput = z.infer<typeof extendSessionSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
```

No `pauseSessionSchema`/`endSessionSchema` — both take no body (matches oikos's own
`pause`'s optional-and-unused `reason`, which this plan drops rather than adding a field
nothing reads).

### Routes — two Hono factories, two audiences (mirrors `members`/`wallet`'s shape)

**Staff-facing — `apps/chrono-api/src/modules/session/routes.ts`, `sessionRoutes()`**
(`TenantVars`, composed into `apps/chrono-api/src/routes/rpc.ts` via
`.route("/sessions", sessionRoutes())`):

- `GET /` — `requirePermission(c.var.tenant.permissions, { session: ["create"] })`... —
  **no**, list is read access; see Permission vocabulary below for why this plan grants
  `session:create`/`session:update` and treats list as ungated (any tenant member),
  matching `project`/`branch`/`station`'s own GET convention. `zValidator("query",
  sessionListQuerySchema)`, optional `branchId`/`stationId`/`memberId`/`status`
  filters, `withTenant`, inner-joins `chronoStation` (name/stationNumber) and
  `base.tenantMember` (name/email) so the board renders without N+1s. Returns
  `{ items, meta }`.
- `POST /` — `requirePermission(..., { session: ["create"] })`. Validates
  `startSessionSchema`. Inside one `withTenant` transaction: look up the station
  (tenant-scoped, 404 if missing) → 409 if `status !== "available"`; look up its group
  → 400 if none; look up the member (tenant-scoped, 404 if missing) → 409 if `status !==
  "active"`; resolve rate (see "Rate resolution"); read the member's wallet balance →
  422 if `<= 0`; insert the session row; update the station to `"occupied"`. A unique-
  index violation on the partial index maps to 409 `STATION_OCCUPIED` (the race-safety
  net). `recordStaffAudit({ action: "session.started", ... })`.
- `POST /:id/pause` — `requirePermission(..., { session: ["update"] })`. 404 cross-tenant.
  409 if `status !== "active"`. Sets `status: "paused"`, `pausedAt: now()`.
  `recordStaffAudit({ action: "session.paused", ... })`.
- `POST /:id/resume` — `requirePermission(..., { session: ["update"] })`. 404
  cross-tenant. 409 if `status !== "paused"`. Adds the elapsed pause segment to
  `pausedDurationSeconds`, sets `status: "active"`, `pausedAt: null`.
  `recordStaffAudit({ action: "session.resumed", ... })`.
- `POST /:id/extend` — `requirePermission(..., { session: ["update"] })`. Validates
  `extendSessionSchema`. 404 cross-tenant. 409 if `status === "ended"`. Sets
  `scheduledEndAt = (scheduledEndAt ?? now()) + minutes`. `recordStaffAudit({ action:
  "session.extended", metadata: { minutes } })`.
- `POST /:id/end` — `requirePermission(..., { session: ["update"] })`. Calls the shared
  `closeSession(tx, {...})` inside `withTenant`. 404 if the session truly doesn't exist;
  otherwise always 200 (whether this call performed the close or found it already
  closed — `alreadyClosed` is informational in the response, not an error).
  `recordStaffAudit({ action: "session.ended", metadata: { finalAmount, amountCharged,
  shortfallAmount } })` — skipped when `alreadyClosed` is true (don't double-audit a
  no-op).

**Customer-facing — `apps/chrono-api/src/modules/session/portal-routes.ts`,
`sessionPortalRoutes()`** (`MemberVars`, `memberMiddleware()`, mounted via `.route(
"/portal/sessions", sessionPortalRoutes())` in `apps/chrono-api/src/app.ts`, mirroring
the existing `/portal/members` and `/portal/wallet` mounts):

- `GET /active` — returns the caller's own currently active/paused session (station
  name, `startedAt`, `scheduledEndAt`, `status`) or `{ session: null }` if none — not a
  404, "no active session" is a normal state. Read-only; no cost-so-far figure returned
  (see Out of Scope — a live estimate is a presentational nice-to-have, not billing
  truth, and this plan doesn't want the portal caller mistaking an estimate for a bill).

### Permission vocabulary — staff holds the full lifecycle (a first for this codebase)

```ts
// packages/agora/src/auth/permissions.ts
export const PERMISSION_STATEMENTS = {
  ...
  session: ["create", "update"],
} as const;
```

- `staffRole` — `session: ["create", "update"]`.
- `adminRole` — `session: ["create", "update"]` (same as staff — no wider action
  exists to grant admin).
- `ownerRole` — inherits automatically.

**Open Question 3 (resolve before Phase 3) — there is no staff-denied action on
`session`, unlike every prior Chrono module.** Every route this plan builds (start/
pause/resume/extend/end) mirrors oikos's own `requireAuth` gate, which never
distinguishes a tenant role for any session route — there is no owner/admin-only
"force-end" or "void billing" action in oikos's evidence to split staff away from. This
plan follows that evidence rather than inventing a stricter tier nobody asked for. The
practical consequence: this module's e2e "role gate" case (`.ai/rules/e2e-testing.md`)
cannot assert a staff-denial within `/rpc/sessions` — instead it asserts the *other*
real gate this module has: a customer's **portal** session (`MemberVars`) cannot reach
any `/rpc/sessions` staff route at all (401/403 depending on how `tenantMiddleware()`
handles a member-only credential — confirm the exact status in Phase 3's routes before
writing the Phase 5 spec). If the developer wants a genuine admin-only tier instead
(e.g. an admin-only "void without billing" override for a mis-started session), that's
a small, clean addition — a `session: ["void"]` action, admin+-only, is the natural
shape — but it is **not** built in this pass since nothing in oikos's own evidence
calls for it.

### Audit action naming

`session.started/.paused/.resumed/.extended/.ended` — checked against every prefix
already in use in this codebase (`project.*`, `file.*`, `customer.*`/`member.*`,
`branch.*`, `chronoMemberProfile.*`, `chronoWallet.*`, `station.*`/`stationGroup.*`) —
no collision.

### Web UI

- **Staff — `apps/chrono-web/src/app/dashboard/sessions/page.tsx` (new)**: an Active
  Sessions board — `useListQuery(["branchId", "status"])` defaulting `status` to a
  combined active+paused view (client-side: request both, or two badges in one list —
  implementor's call, either is compliant), `api.rpc.sessions.$get({ query: {...} })`,
  `DataTable`/`DataTableGrid` + `DataTableToolbar` (branch filter `Select`, same shape
  as `stations`' own toolbar filter) + `DataTablePagination` from `agora/ui`. Since no
  realtime infra exists (see Pass 2), the page refetches on a client `setInterval`
  (e.g. 10–15s — pick one, document it inline) **in addition to** `useListQuery`'s
  normal on-navigation fetch; each row shows a **client-computed** countdown/elapsed
  timer ticking every second from `startedAt`/`scheduledEndAt` (no extra network call
  per tick — the tick is pure `Date` math, matching how oikos itself computed its
  on-screen timer even with sockets available). A **Start Session** `Dialog`: station
  `Select` (options from `GET /rpc/stations?status=available`, `agora/ui` primitives
  only), member `Select`/search (options from `GET /rpc/customers`), optional duration
  `Input type="number"`. Row actions: Pause / Resume / Extend (small dialog for
  minutes) / End (confirmation `Dialog` — billing-triggering, matches the destructive-
  action confirm pattern `stations`' own delete uses).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Sessions` entry to `BASE_NAV`
  (a `Timer`/`PlayCircle`-style `lucide-react` icon) and `"/dashboard/sessions":
  "Sessions"` to `TITLES`, mirroring the `Branches`/`Stations`/`Members`/`Wallets`
  entries (exact insertion point depends on whichever of those has landed by the time
  this phase runs — insert alongside them, don't assume a fixed line number, same
  caveat `stations`' own Phase 4 already noted).
- **Customer — extend `apps/chrono-web/src/app/portal/page.tsx` further** (already
  extended by `members`' Membership card and `wallet`'s Wallet card): add a "Current
  session" `Card` — station name + status + a client-ticking elapsed/remaining timer if
  a session exists (`GET /portal/sessions/active`), or nothing/an empty state if none.
  New small client helper `apps/chrono-web/src/lib/session-portal.ts`
  (`getMyActiveSession()`), mirroring `member-application.ts`/`wallet-portal.ts`'s shape
  exactly.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List (staff) | `GET /rpc/sessions` | none (any tenant member) | paginated, filterable by branch/station/member/status |
| Start (staff) | `POST /rpc/sessions` | `session:create` | 409 station occupied, 400 no pricing group, 409 member suspended, 422 zero/negative balance |
| Pause (staff) | `POST /rpc/sessions/:id/pause` | `session:update` | 409 if not active |
| Resume (staff) | `POST /rpc/sessions/:id/resume` | `session:update` | 409 if not paused |
| Extend (staff) | `POST /rpc/sessions/:id/extend` | `session:update` | 409 if already ended |
| End (staff) | `POST /rpc/sessions/:id/end` | `session:update` | idempotent — always 200, `alreadyClosed` flag in response |
| Active (customer) | `GET /portal/sessions/active` | member session | `{ session: null }` if none |
| Delete | — | — | not built this pass — a session is never deleted, only ended; historical rows are permanent billing records |

Feedback: `toast.success`/`toast.error` at the point of the API call
(`.ai/rules/ui.md`), matching every prior module's inline-message convention — the
422 insufficient-balance message and the 409 station-occupied/400 no-pricing-group
messages surfaced verbatim.

Audit linkage: `recordStaffAudit` on every lifecycle transition except a no-op
`alreadyClosed` end; the `.ended` entry's metadata carries the financial outcome
(`finalAmount`/`amountCharged`/`shortfallAmount`), matching `wallet`'s own "an amount
must be in the audit entry, not just the action name" principle.

### Out of Scope (this plan)

- **Device pairing/unlock signals.** `devices`' concern. Touchpoint noted only: a
  session start/end is the natural place a future `devices` integration would send a
  lock/unlock command (best-effort, non-blocking, exactly how oikos wraps its own
  `emitDeviceCommand` calls) — no such call is made in this pass.
- **Realtime/websocket live updates.** No infrastructure exists; explicitly deferred as
  a separate, named follow-up plan — **`chrono-realtime-updates`** (see Pass 2).
- **`session-warnings` background job.** No receiving client exists in this migration
  pass (`chrono-pc-client` out of scope entirely) — cut, not deferred-with-a-name, since
  there is nothing to build it *for* yet.
- **The lot-based time-credit fallback (`CreditGrants`).** Already cut by `wallet`'s own
  plan; this plan bills wallet cash only and caps/records a shortfall instead.
- **The full `PricingRule` engine** (day/time windows, promos, membership-tier
  resolution beyond the flat member/hourly split). Already cut by `stations`' own plan.
- **Away-lock / staff-override-away-unlock / transfer-to-another-station.** Real oikos
  features, hardware- or complexity-coupled, no strong Wave-1 need (see "Deliberately
  narrowed").
- **`DeviceSessionEvents`/`AppUsageEvents`-equivalent tables.** Subsumed by
  `recordStaffAudit` / not applicable without a PC client (see "Deliberately narrowed").
- **A live cost-so-far figure on the portal or staff board beyond a client-computed
  estimate.** The only authoritative amounts (`finalAmount`/`amountCharged`) are
  computed once, at close — a running total is presentational only, never persisted or
  trusted mid-session.
- **The `/rpc-admin` platform-admin cross-tenant view.** No `PLATFORM_PERMISSION_
  STATEMENTS` resource exists for this today, same reasoning as every prior module.
- **A `session.*` webhook event.** Trivial follow-up, not required to ship, same
  deferral every prior module made.
- **Self-service session start/end from the customer portal.** Staff-driven-counter
  workflow only in this pass, matching how oikos's own self-service path is the
  kiosk PC client, not a web portal.

---

## Open Questions summary (confirm before/при Phase 3)

1. **Billing model fidelity** — single final debit at close vs. oikos's multi-checkpoint
   ticking (login-minimum + pause-ticks + end). This plan builds the simpler single-debit
   model. Reconsider only if a real product need for incremental/running charges
   surfaces.
2. **Insufficient-balance-at-close handling** — cap the debit at the current wallet
   balance and record a `shortfallAmount` on the session row, rather than oikos's
   credit-grant fallback (which doesn't exist in this codebase) or rejecting the close
   outright (which would leave a session un-closeable and a station permanently
   occupied — worse).
3. **No staff-denied action exists on `session`** — matches oikos's own evidence
   (`requireAuth`, no role split found on any session route). The e2e role-gate case
   asserts portal-vs-staff route separation instead of a staff-vs-admin split. Add a
   `session:void` admin-only override later if a real need for one surfaces.
4. **`stationId` FK is `onDelete: "restrict"`** — a required, load-bearing follow-up:
   once this plan lands, `stations`' `DELETE /rpc/stations/:id` route (not yet
   implemented as of this writing) must catch the new FK-violation and return a clean
   409 (`"This station has session history and cannot be deleted."`), not let a raw
   Postgres constraint error surface as a 500. Flag this to whoever implements/finishes
   `stations`.
5. **Station-status desync risk** — nothing in this plan stops staff `PATCH`-ing a
   station's `status` to `maintenance`/`offline` while a session has it `occupied`
   (stations' own `PATCH` route has no session-awareness, since it was planned before
   sessions existed). Not solved here — flagged for the developer to decide whether
   stations' `PATCH` route should reject overriding an occupied station, or whether that
   should force-end the session, or whether it's an acceptable edge case for Wave 1.
6. **Multiple simultaneous active sessions per customer** (across different stations)
   are allowed, matching oikos (which only restricts one active session **per
   station**, never per member). Not a new gap this plan introduces.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/session/schema.ts` (new) — `chronoSession` table (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export `chronoSession`, add
  `"ChronoSessions"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/session/` and write `schema.ts` exactly as
   specified in Pass 2 — importing `chronoBranch` from `../branch/schema`,
   `chronoStation` from `../station/schema`, and `chronoWalletTransaction` from
   `../wallet/schema` (all three must exist on disk by the time this phase runs — a real
   ordering dependency, not just documentation, same caveat `stations`' own Phase 1
   flagged for its `chronoBranch` dependency).
2. In `apps/chrono-api/src/db/schema.ts`, add the import/re-export and append
   `"ChronoSessions"` to `APP_TENANT_TABLES` (check the file's current state first —
   don't clobber a concurrently-landed `stations`/`members`/`wallet` entry).
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_sessions` (never
   `db:push`). Review the generated SQL: expect `CREATE TABLE "ChronoSessions"` plus its
   six indexes (including the partial unique index — confirm the generated `WHERE`
   clause reads `status in ('active','paused')` verbatim) and three FKs
   (`chronoBranch`/`chronoStation` restrict/`tenantMember` cascade), no destructive
   statements.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- `ChronoSessions` exists with `FORCE ROW LEVEL SECURITY` on.
- `"ChronoSessions"` is present in `APP_TENANT_TABLES`.
- The partial unique index exists and its `WHERE` clause matches `status in
  ('active','paused')`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, routes, service, sweep, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/session/schema.ts`.

---

## Phase 2 — Contracts + money helper

**Files to update**

- `apps/chrono-api/src/modules/session/contracts.ts` (new) — Zod schemas (Pass 2).
- `apps/chrono-api/src/modules/session/money.ts` (new) — `computeMeteredCharge`/
  `capMoney` (Pass 2's "Money math" note).

**Step-by-step tasks**

1. Write `sessionStatusSchema`, `startSessionSchema`, `extendSessionSchema`,
   `sessionListQuerySchema` and their `z.infer` types exactly as specified in Pass 2.
2. Write `money.ts`: `computeMeteredCharge(billableSeconds: number, ratePerHour:
   string): string` (BigInt-cents, round-half-up — add half the denominator before
   integer division, never `Number()`/float math) and `capMoney(amount: string, ceiling:
   string): string` (BigInt-cents comparison, returns the lesser of the two, floored at
   `"0.00"`). Import `toCents`/`fromCents` from `../wallet/money` — do not
   re-implement cents conversion locally.
3. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- `StartSessionInput`/`ExtendSessionInput`/`SessionStatus` types compile and are
  importable from `../modules/session/contracts`.
- `computeMeteredCharge(3600, "100.00") === "100.00"`;
  `computeMeteredCharge(1800, "100.00") === "50.00"`;
  `computeMeteredCharge(1, "100.00")` rounds to the nearest cent, not truncates to
  `"0.00"` silently below a cent threshold (verify the round-half-up boundary case
  explicitly, e.g. a value that lands exactly on `.5` cents).
- `capMoney("120.00", "45.50") === "45.50"`; `capMoney("10.00", "50.00") === "10.00"`;
  `capMoney("10.00", "-5.00") === "0.00"`.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, service, sweep, UI.

**Execution start point:** create `apps/chrono-api/src/modules/session/money.ts` (write
money math first so Phase 3's service composes it directly).

---

## Phase 3 — Service (close/lifecycle) + routes + permission gates

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `session: ["create", "update"]` to
  `PERMISSION_STATEMENTS`, `staffRole`, and `adminRole` (resolve Open Question 3 first —
  Pass 2).
- `apps/chrono-api/src/modules/session/service.ts` (new) — `closeSession` and any
  shared start/pause/resume/extend helpers (Pass 2).
- `apps/chrono-api/src/modules/session/routes.ts` (new) — `sessionRoutes()` factory
  (`TenantVars`).
- `apps/chrono-api/src/modules/session/portal-routes.ts` (new) — `sessionPortalRoutes()`
  factory (`MemberVars`, `memberMiddleware()`).
- `apps/chrono-api/src/modules/session/concurrency.test.ts` (new) — standalone `tsx`
  script proving the atomic-claim close is race-safe, mirroring `wallet`'s own
  `concurrency.test.ts` structure and its "real Postgres, not pglite" requirement.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/sessions", sessionRoutes())`.
- `apps/chrono-api/src/app.ts` — `.route("/portal/sessions", sessionPortalRoutes())`.
- `apps/chrono-api/package.json` — add `"test:session-concurrency": "tsx
  src/modules/session/concurrency.test.ts"`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `session` gate cases (staff
  allowed `create`/`update`, matching Open Question 3's resolution — no denial case
  within this resource).

**Step-by-step tasks**

1. Resolve Open Question 3, then edit `permissions.ts` per Pass 2's exact statement/role
   composition.
2. Write `service.ts`: `closeSession(tx, {...})` exactly as specified in Pass 2 — the
   single atomic `UPDATE ... WHERE status IN ('active','paused') ... RETURNING *` claim,
   billable-seconds computation, `computeMeteredCharge`/`capMoney` from `money.ts`, the
   conditional `debitWallet` call (only when `amountCharged > 0`), the station-status
   reset to `"available"`. This is the ONLY function that transitions a session to
   `"ended"` — the route and the sweep (Phase 4) both call it, never duplicate its logic.
3. Write `routes.ts`: `GET /` (ungated beyond tenant membership, paginated + filtered),
   `POST /` (`session:create`, the full start sequence from Pass 2 including the
   station-lookup/group-lookup/member-lookup/balance pre-check, unique-violation → 409
   mapping), `POST /:id/pause`, `/:id/resume`, `/:id/extend`, `/:id/end` (all
   `session:update`, `/:id/end` delegating to `closeSession`). Follow the exact structure
   of the `/customers`/`/wallets` blocks in `apps/chrono-api/src/routes/rpc.ts` (import
   style, `HttpError`, pagination meta shape, `withTenant` composition).
4. Write `portal-routes.ts`: `GET /active` (no auto-create, `{ session: null }` when
   none).
5. Compose into `apps/chrono-api/src/routes/rpc.ts` and `apps/chrono-api/src/app.ts`,
   exactly mirroring `wallet`'s own `/portal/wallet` mount.
6. Write `concurrency.test.ts`: seed one tenant + branch + station + station group (rate
   set) + `tenantMember` + wallet with a starting balance, start one session, then fire
   **N concurrent** calls to the equivalent of `POST /:id/end` (direct `closeSession`
   invocations against a **real Postgres** connection — `DATABASE_URL_ADMIN`, not
   `DB_DRIVER=pglite`, same requirement `wallet`'s own concurrency test states and for
   the same reason: pglite is single-instance and cannot exercise real row-lock/claim
   contention) and assert: (a) exactly ONE of the N calls actually performed the close
   (`alreadyClosed === false` on exactly one, `true` on the rest); (b) exactly one
   `ChronoWalletTransactions` row was created for that session (no double-billing); (c)
   the station's `status` is `"available"` exactly once-transitioned, not corrupted by a
   second racing writer. This is the test that actually proves "the sweep and a manual
   end can never double-bill" — `typecheck`/`rls:proof` alone cannot catch a race.
7. Add `session` cases to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { session: ["create"] }) === true`,
   `hasPermission("staff", { session: ["update"] }) === true`,
   `hasPermission("admin", { session: ["create"] }) === true`,
   `hasPermission("owner", { session: ["update"] }) === true` (no denial case per Open
   Question 3 — document that explicitly in a code comment so a future reader doesn't
   mistake the absence of a `false` assertion for an oversight).

**Acceptance criteria**

- `POST /rpc/sessions` on an unavailable station → 409; on a station with no group →
  400; for a suspended member → 409; for a member with a zero/negative wallet balance →
  422; happy path → 201 with the created row, station now `"occupied"`.
- Two concurrent `POST /rpc/sessions` for the same station → exactly one 201, the other
  409 `STATION_OCCUPIED`.
- `POST /rpc/sessions/:id/end` twice (sequential) → both 200, second response has
  `alreadyClosed: true`, no second wallet debit.
- `pnpm --filter @agora/chrono-api test:session-concurrency` passes — exactly one
  close, one wallet transaction, correct final station status.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `session`
  cases.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:session-concurrency`

**Out of scope:** the background sweep itself (Phase 4), UI, e2e browser spec (Phase 6).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (the
route files reference the new resource, so the vocabulary must exist before either
typechecks).

---

## Phase 4 — Background expiry sweep

**Files to update**

- `apps/chrono-api/src/modules/session/expiry.ts` (new) — `runSessionExpirySweepOnce`/
  `startSessionExpiryWorker` (Pass 2).
- `apps/chrono-api/src/index.ts` — start the worker alongside the existing
  `startQueueWorker(...)`/`startRetentionWorker()` calls, with a matching
  `stopSessionExpiryWorker()` in the `SIGINT`/`SIGTERM` handler.

**Step-by-step tasks**

1. Write `expiry.ts` exactly as specified in Pass 2 — the `withAdmin` due-row scan
   (batch-capped at 200, matching oikos's own cap), the per-row `withTenant(row.tenantId,
   tx => closeSession(tx, {...}))` call (reusing Phase 3's `closeSession`, never a
   second billing implementation), the `setInterval` + `.unref()` wrapper,
   `SESSION_EXPIRY_SWEEP_INTERVAL_MS` env override (default `60_000`).
2. Wire `startSessionExpiryWorker()` into `apps/chrono-api/src/index.ts`, mirroring the
   exact structure of `startRetentionWorker()` in `apps/agora-api/src/index.ts` (import,
   call at bootstrap, `stop...()` in the signal handler alongside the others).
3. Document `SESSION_EXPIRY_SWEEP_INTERVAL_MS` in `apps/chrono-api/.env.example` if one
   exists (optional — a sensible default with no env var set is fine for local dev).

**Acceptance criteria**

- A session started with `durationMinutes: 1` and left untouched is auto-closed
  (`status: "ended"`, station back to `"available"`, a wallet debit recorded) within
  roughly one sweep interval of its `scheduledEndAt` passing — verified by running
  `runSessionExpirySweepOnce()` directly in a script/REPL against a seeded past-due
  session (no need to wait a real 60s in an automated check).
- An open-ended session (`scheduledEndAt: null`) is never touched by the sweep, no
  matter how long it runs.
- The sweep is safe to run concurrently with a manual `POST /:id/end` on the same
  session (proven already by Phase 3's `test:session-concurrency`, which exercises
  `closeSession` directly — this phase does not need its own separate concurrency
  test, since it calls the exact same function).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- Manual/scripted check per the acceptance criteria above (no dedicated automated test
  file required for this phase beyond what Phase 3 already proved for `closeSession`
  itself).

**Out of scope:** UI, e2e browser spec.

**Execution start point:** create `apps/chrono-api/src/modules/session/expiry.ts`.

---

## Phase 5 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/sessions/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `apps/chrono-web/src/app/portal/page.tsx` — extend with a "Current session" card.
- `apps/chrono-web/src/lib/session-portal.ts` (new) — thin client wrapper for
  `GET /portal/sessions/active`.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected; `Dialog`/`Select`/`Input`/`Label` already exist).

**Step-by-step tasks**

1. Build `dashboard/sessions/page.tsx` per Pass 2's Web UI section: `useListQuery(
   ["branchId", "status"])`, `api.rpc.sessions.$get/$post/[":id"].pause.$post/.resume.
   $post/.extend.$post/.end.$post`, `DataTable`/`DataTableGrid` + `DataTableToolbar`
   (branch filter) + `DataTablePagination`, a client `setInterval` refetch (document the
   chosen interval inline), a per-row client-computed ticking timer, Start Session
   dialog, row action dialogs (Pause/Resume/Extend/End with confirm).
2. Add `{ type: "item", name: "Sessions", href: "/sessions", icon: <Timer> }` to
   `BASE_NAV`, and `"/dashboard/sessions": "Sessions"` to `TITLES`, in
   `apps/chrono-web/src/app/dashboard/layout.tsx`.
3. Write `apps/chrono-web/src/lib/session-portal.ts`: `getMyActiveSession()`.
4. Extend `apps/chrono-web/src/app/portal/page.tsx`: add a "Current session" `Card` next
   to the existing Account/Membership/Wallet cards.
5. Wire `toast.success`/`toast.error` on every mutation.

**Acceptance criteria**

- `/dashboard/sessions` renders the board; branch filter + search/sort/paginate/
  view-toggle update the URL; a started session shows its station as occupied and
  blocks a second start on it (server 409 surfaces as a toast).
- Pause/Resume/Extend/End all work and the board refreshes/reflects the new state.
- `/portal` shows the current session (or nothing) for the signed-in customer.
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 6), any realtime/websocket wiring.

**Execution start point:** create
`apps/chrono-web/src/app/dashboard/sessions/page.tsx`.

---

## Phase 6 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/sessions/sessions.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring
   `apps/chrono-web/e2e/tests/data-listing/projects-listing.spec.ts`'s structure and
   `signUp()` helper, covering three cases per `.ai/rules/e2e-testing.md` (adjusted per
   Open Question 3 — see below):
   - **Happy path**: sign up a tenant, create a branch + station + station group (rate
     set) + a customer with a top-up (reuse those modules' own e2e helpers/flows if
     landed, otherwise drive inline via the API), start a session with a short duration,
     confirm the station shows occupied and a second start on it 409s; pause, confirm
     the timer stops advancing (assert via the API response's `pausedAt`, not a visual
     wait); resume; end early, confirm the wallet balance decreased by a plausible
     amount and the station returns to available; confirm the customer's `/portal` no
     longer shows a current session.
   - **Role gate** (per Open Question 3, this is a *portal-vs-staff* gate, not a
     staff-vs-admin one): a signed-in **customer** (portal session) attempting to call
     any `/rpc/sessions/*` staff route is refused (401/403 — assert whichever
     `tenantMiddleware()` actually returns for a member-only credential); a **staff**
     session can start/pause/resume/extend/end without any 403 (documenting that this
     module intentionally has no staff-denial case).
   - **Tenant isolation**: tenant A starts a session on its own station for its own
     customer; tenant B's `/dashboard/sessions` list never shows it (search/filter
     included), and a direct cross-tenant `sessionId` on any lifecycle route 404s.
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for slugs/emails/names/
   station numbers, per the rule's explicit requirement.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config, per `.ai/rules/rbac.md`'s "Testing" section).
- No `.env` present in `apps/chrono-api` while running (drives the real dev server).

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/sessions/sessions.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage; a browser-driven concurrency test (Phase
3's `test:session-concurrency` already proves the race is closed — Playwright is the
wrong tool for a DB-level race, same reasoning `wallet`'s own Phase 5 gave).

**Execution start point:** create
`apps/chrono-web/e2e/tests/sessions/sessions.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/sessions/` to
`.ai/plans/chrono/archive/sessions/` once all six phases are verified and committed
separately. Update `.ai/handover/chrono-migration.md`'s status table
(`sessions: done, committed (<hash>)`) — this closes out Wave 1's dependency graph
entirely (nothing else depends on `sessions`). Before archiving, confirm Open Question 4
(the `stations` DELETE-route FK-violation follow-up) has either been actioned in
`stations`' own implementation or explicitly deferred with the developer's sign-off —
don't let it silently fall through the cracks between two plans. Also confirm the
**`chrono-realtime-updates`** follow-up (Pass 2) has been logged somewhere the developer
will actually see it again (a line in `.ai/handover/chrono-migration.md`'s "Newly
discovered during planning" section, matching how the `credits` system was logged there
by the `wallet` plan, is the natural place).
