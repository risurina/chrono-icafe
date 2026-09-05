/**
 * Two periodic maintenance passes over ChronoAppUsageEvents, run by one
 * worker on one interval (Phase 3, "Orphaned-run policy" + "Retention" in
 * .ai/plans/chrono/in-progress/app-usage/README.md):
 *
 *  - closeStaleAppUsageRuns(): force-closes a run whose device has gone
 *    stale (no heartbeat past APP_USAGE_STALE_DEVICE_MINUTES), so a crashed/
 *    reimaged kiosk doesn't leave a permanent zombie row in "Currently
 *    Running". Mirrors runSessionExpirySweepOnce()'s own
 *    withAdmin-read-then-withTenant-write shape
 *    (apps/chrono-api/src/modules/session/expiry.ts).
 *  - pruneAppUsageEvents(): deletes rows past APP_USAGE_RETENTION_DAYS —
 *    business-specific data, scoped to this app per .ai/rules/architecture.md's
 *    Non-Goals, never edited into the foundation's own retention.ts
 *    (packages/agora/src/core/server/retention.ts).
 *
 * Both batch-capped at 200/tick — a telemetry table's full backlog is
 * expected to be large, unlike the foundation sweep's much lower audit-event
 * volume, so an uncapped DELETE/scan per tick would be a long-running
 * transaction. The next interval tick picks up the rest — no "loop until
 * drained" shape, matching runSessionExpirySweepOnce()'s own precedent.
 */
import { withAdmin, withTenant, eq, and, isNull, lt, sql } from "agora/db";
import { logger } from "agora/server";
import { chronoAppUsageEvent } from "./schema";
import { chronoDevice } from "../device/schema";

// Matches the ingest route's own cap (routes.ts) — a force-closed run must
// never report a duration a normal close would have rejected.
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const BATCH_CAP = 200;

function staleDeviceThreshold(): Date {
  const minutes = Number(process.env.APP_USAGE_STALE_DEVICE_MINUTES) || 15;
  return new Date(Date.now() - minutes * 60_000);
}

/** The orphaned-run policy: force-close a run whose device has gone stale. */
export async function closeStaleAppUsageRuns(): Promise<{ closed: number }> {
  const threshold = staleDeviceThreshold();

  const due = await withAdmin((tx) =>
    tx
      .select({
        id: chronoAppUsageEvent.id,
        tenantId: chronoAppUsageEvent.tenantId,
        startedAt: chronoAppUsageEvent.startedAt,
        deviceLastSeenAt: chronoDevice.lastSeenAt,
      })
      .from(chronoAppUsageEvent)
      .innerJoin(chronoDevice, eq(chronoAppUsageEvent.deviceId, chronoDevice.id))
      .where(and(isNull(chronoAppUsageEvent.endedAt), lt(chronoDevice.lastSeenAt, threshold)))
      .limit(BATCH_CAP),
  );

  let closed = 0;
  for (const row of due) {
    // A device that has never sent a heartbeat has no lastSeenAt to force-
    // close from (the WHERE above already excludes these via SQL's NULL
    // comparison semantics) — this guard only narrows the type.
    if (!row.deviceLastSeenAt) continue;

    const endedAt = row.deviceLastSeenAt;
    const durationSeconds = Math.max(
      0,
      Math.min(
        MAX_DURATION_SECONDS,
        Math.floor((endedAt.getTime() - row.startedAt.getTime()) / 1000),
      ),
    );

    await withTenant(row.tenantId, (tx) =>
      tx
        .update(chronoAppUsageEvent)
        .set({
          endedAt,
          durationSeconds,
          closedReason: "stale_device",
          updatedAt: new Date(),
        })
        .where(and(eq(chronoAppUsageEvent.id, row.id), isNull(chronoAppUsageEvent.endedAt))),
    );
    closed++;
  }
  return { closed };
}

/** Hard-deletes rows past the retention window — high-volume telemetry, not
 * a financial/audit record, so no soft-delete/history-preservation need. */
export async function pruneAppUsageEvents(): Promise<{ deleted: number }> {
  const retentionDays = Number(process.env.APP_USAGE_RETENTION_DAYS) || 90;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const deleted = await withAdmin((tx) =>
    tx
      .delete(chronoAppUsageEvent)
      .where(
        sql`${chronoAppUsageEvent.id} IN (
          SELECT ${chronoAppUsageEvent.id} FROM ${chronoAppUsageEvent}
          WHERE ${chronoAppUsageEvent.createdAt} < ${cutoff}
          LIMIT ${BATCH_CAP}
        )`,
      )
      .returning({ id: chronoAppUsageEvent.id }),
  );
  return { deleted: deleted.length };
}

const APP_USAGE_SWEEP_INTERVAL_MS =
  Number(process.env.APP_USAGE_SWEEP_INTERVAL_MS) || 300_000; // 5 min

export function startAppUsageSweepWorker(): () => void {
  const timer = setInterval(() => {
    closeStaleAppUsageRuns().catch((err) => {
      logger.error({ msg: "app-usage stale-run sweep failed", error: String(err) });
    });
    pruneAppUsageEvents().catch((err) => {
      logger.error({ msg: "app-usage retention prune failed", error: String(err) });
    });
  }, APP_USAGE_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
