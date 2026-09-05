# Member reservations & queue

Chrono's reservation system has two independent paths, both built on the single
`ChronoReservations` table (`apps/chrono-api/src/modules/reservation/`):

- **Path 1 — staff-created bookings** (`/dashboard/reservations`): a staff member books
  a station on a customer's behalf. Shipped earlier; unchanged by this doc.
- **Path 2 — member self-service** (`/portal/reservations`, this doc): a `tenantMember`
  reserves a station directly, or joins a queue for a busy one. This is the deferred
  follow-up the original reservations plan flagged as Open Questions 8–11, built now
  that `devices`/`sessions` exist.

## Flow 1 — direct reservation

A member picks a station and a start time (`startAt`) + duration. Server-side rules:

- `startAt` must be strictly in the future and no more than
  `reservationAdvanceWindowMinutes` (default 60) away — i.e.
  `startAt > now && startAt <= now + reservationAdvanceWindowMinutes`.
- One active reservation/queue-entry per member at a time (member-originated rows only
  — a staff booking on a member's behalf is unaffected).
- The member must not hold an active `RESERVATION_BAN`.
- **The station is not locked at booking time.** A reservation for 3 hours from now
  does not prevent someone from using the station right now — the station's *current*
  occupant is irrelevant to a *future* slot. The real double-booking guarantee is a
  Postgres exclusion constraint on `(tenantId, stationId, [startAt, endAt))`.
- At `startAt`, a background sweep flips the reservation from `confirmed` to `hold`,
  opening a `holdPeriodMinutes` (default 30) claim window. From this moment the station
  is soft-locked for that member — even before a session exists, another member's
  session-start attempt on that station is refused.
- **The member claims the hold by scanning the station's QR code** (same flow as
  ordinary walk-in check-in) — there is no in-portal "start session" button. Scanning
  claims the hold: the reservation moves to `checked_in`, a `ChronoSessions` row starts,
  and normal Chrono billing applies from that point (billing duration is whatever the
  session actually runs, not clamped to the originally requested duration).
- Unclaimed at `holdExpiresAt` → `no_show`, a `RESERVATION_BAN` for
  `reservationBanDurationHours` (default 24h), and the station is freed for whoever's
  next in the queue (if any).

## Flow 2 — join the queue

If a station is currently occupied, or has a live hold/checked-in reservation on it, a
member may join its queue instead: `POST /portal/reservations/queue` with a requested
duration. Queue entries are FIFO (`ChronoReservations` rows with `fromQueue: true`,
`status: "pending"`, no `startAt`/`endAt` until promoted). Joining and waiting are free.

When the station frees — a session ends, a blocking hold's `holdPeriodMinutes` expires,
or an active hold is cancelled — the sweep (or the triggering action, for an immediate
promotion on cancel) promotes the oldest `pending` row to `hold`, with a fresh
`holdPeriodMinutes` window. The promoted window is clamped against any later booking
already on the station, so a promotion can never violate the double-booking guarantee;
if the clamped window would be under 15 minutes, promotion is skipped for that tick and
retried later rather than losing the member's place.

The promoted member claims the same way as Flow 1 (QR scan), or can explicitly schedule
it via `POST /portal/reservations/:id/confirm` (reserves the slot without starting play
— useful if the member isn't at the venue yet).

Missing a queue hold records a `queue_failure` history entry (not a ban by itself).
Reaching `queueFailureLimit` (default 1) inserts a `QUEUE_BAN` for
`queueBanDurationHours` (default 24h). The count is cumulative — every failure a member
has ever had at that branch, not a rolling window.

## Cancellation

`POST /portal/reservations/:id/cancel`. A **queue** cancellation (`fromQueue: true`) is
always free, no ban, regardless of timing. A **scheduled** (direct) reservation's
cancellation is evaluated against `lateCancellationWindowMinutes` (default 30) measured
back from `startAt`:

- Outside the window: `cancelled`, no fee, no ban.
- Inside the window, or at/after the scheduled start itself: `cancelled_late`, the
  configured `cancellationFeeAmount` is recorded on the row (not automatically debited
  from the wallet — staff collect it at the counter), and a `RESERVATION_BAN` for
  `reservationBanDurationHours` is applied.

Cancelling an active hold promotes the next queued member immediately, rather than
waiting for the next sweep tick.

## Restrictions (bans)

`ChronoMemberReservationRestrictions` is the append-only history/audit source of truth —
never `ChronoReservations.status` alone. Two ban types are checked independently:

- **`RESERVATION_BAN`** blocks Flow 1 (direct reservations). Reasons:
  `late_cancellation`, `no_show`, `scheduled_time_cancellation`, `admin_manual`.
- **`QUEUE_BAN`** blocks Flow 2 (joining a queue). Reason: `queue_failure_limit`.

A `queue_failure` row is a third `type` — a pure history record for one missed queue
hold, never itself a ban.

A staff member can lift a wrongly-issued ban (`POST /reservations/restrictions/:id/lift`,
`reservation:managePolicy`) — this appends `liftedAt`/`liftedByUserId` rather than
deleting the row, so history stays immutable.

## Admin policy

`ChronoReservationPolicies` — one row per tenant (`branchId IS NULL`, the tenant
default) or per branch (a full override). Resolution: a branch row, if one exists, is
used in full; else the tenant-default row in full; else the hardcoded defaults below. A
branch either fully overrides every field or falls back to the tenant default — there is
no per-field inheritance.

| Field | Default |
|---|---|
| `enabled` | `true` |
| `reservationAdvanceWindowMinutes` | `60` |
| `maxActiveReservationsPerMember` | `1` (DB-enforced at exactly 1; the field is read but the constraint doesn't generalize past it) |
| `lateCancellationWindowMinutes` | `30` |
| `cancellationFeeEnabled` | `true` |
| `cancellationFeeAmount` | `20` |
| `reservationBanDurationHours` | `24` |
| `noShowBanDurationHours` | `24` |
| `holdPeriodMinutes` | `30` (unified — the same field governs both a direct reservation's post-activation claim window and a queue promotion's claim window; the original spec's separate `queueHoldMinutes` was dropped as redundant) |
| `queueFailureLimit` | `1` |
| `queueBanDurationHours` | `24` |
| `allowQueueForReservedPc` | `true` |
| `allowQueueForInUsePc` | `true` |

Existing tenants (no policy row at all) get the hardcoded defaults exactly — no
migration/backfill needed.

Staff manage policy via `GET`/`PATCH /reservations/policy?branchId=` (gated
`reservation:managePolicy`, admin/owner only — staff can read/manage bookings but not
change policy). No dedicated admin UI page ships with this pass; the API is the surface
until one is asked for.

## API surface

**Member portal** (`memberMiddleware()`-gated, `/portal/reservations`):

- `GET /` — the member's current active reservation/queue entry + computed queue position.
- `GET /policy?stationId=` — resolved policy for that station's branch.
- `GET /restrictions` — the member's own active bans (type/reason/unban date only).
- `POST /` — direct reservation (Flow 1).
- `POST /queue` — join the queue (Flow 2).
- `POST /:id/confirm` — schedule from a live hold (Option B).
- `POST /:id/cancel` — cancel, fee/ban computed server-side.

**Staff** (`/dashboard`, permission-gated, extends the existing path-1 routes):

- `GET`/`PATCH /reservations/policy?branchId=` — `managePolicy`.
- `GET /reservations/restrictions?memberId=` — full detail, paginated — `read`.
- `POST /reservations/restrictions/:id/lift` — `managePolicy`.

## Differences from the original brief

- **Advance-booking framing.** The station is never locked for the lead time between
  booking and `startAt` — only from `startAt` onward. Locking it earlier would leave a
  station idle for up to an hour for no reason; the exclusion constraint already
  guarantees no double-booking regardless.
- **Unified hold window.** `holdPeriodMinutes` replaces the brief's separate
  `queueHoldMinutes` — both "claim your activated direct reservation" and "claim your
  promoted queue slot" are the same concept operationally.
- **Claim path is QR-scan-only.** No new "start session from the portal" endpoint —
  claiming reuses the existing QR check-in flow, matching how the product already works.
- **Cancellation fee is recorded, not auto-debited.** Staff collect it manually; charging
  a wallet for a cancellation penalty is a different trust decision than session billing.
- **Whole-row, not per-field, policy override.** A branch either has its own complete
  policy or uses the tenant default in full.

See `.ai/plans/chrono/archive/reservations-queue-and-self-service/README.md` for the full
plan, its two audit rounds, and every decision's reasoning.
