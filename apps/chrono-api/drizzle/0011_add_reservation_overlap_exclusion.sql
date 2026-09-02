-- Hand-written (audit-remediation Phase 2): Drizzle has no first-class EXCLUDE
-- constraint API, so drizzle-kit generate produces no diff for this change.
-- This is the real double-booking guarantee — the app-level
-- `SELECT ... FOR UPDATE` pre-check (assertNoOverlap, routes.ts) cannot
-- serialize against a reservation row that does not exist yet.
--
-- CREATE TYPE-style idempotency isn't applicable to CREATE EXTENSION (it is
-- already idempotent via IF NOT EXISTS) or to ADD CONSTRAINT (Postgres has no
-- IF NOT EXISTS for constraints), so this migration is guarded to only ever
-- run once via the normal drizzle migration ledger, not by a DO $$ wrapper.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_no_overlap"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "stationId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  ) WHERE (status IN ('confirmed', 'checked_in'));
