import { Hono } from "hono";
import { withTenant, eq, and, inArray, isNull, type TenantTx } from "agora/db";
import { HttpError, zValidator, createRateLimiter } from "agora/server";
import { createId } from "agora";
import { chronoAppUsageEvent } from "./schema";
import { chronoSession } from "../session/schema";
import { reportAppUsageEventsSchema } from "./contracts";
import { requireDeviceBearerAuth, type DeviceAuthVars } from "../device/device-auth-middleware";

// A run reporting longer than this is treated the same as a bad clock —
// rejected rather than silently accepted and let it dominate every aggregate
// (Payload Contracts). 7 days, in seconds.
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

// This is expected, routine traffic (a hot per-process event stream), not an
// incident report — a materially higher ceiling than
// deviceSecurityAlertLimiter's 10/hour. A stated starting default, not
// load-tested against a real PC-client's actual batching cadence (Open
// Question 2) — see .ai/plans/chrono/in-progress/app-usage/README.md.
const deviceAppUsageLimiter = createRateLimiter(60, 60_000, "device-app-usage");

/** The tenant's own currently active/paused session on a station, if any. */
async function resolveActiveSessionId(
  tx: TenantTx,
  tenantId: string,
  stationId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: chronoSession.id })
    .from(chronoSession)
    .where(
      and(
        eq(chronoSession.tenantId, tenantId),
        eq(chronoSession.stationId, stationId),
        inArray(chronoSession.status, ["active", "paused"]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Device-facing app-usage ingest (Phase 2). NO Better Auth session and NO
 * tenant membership row — the device itself authenticates via
 * requireDeviceBearerAuth(), exactly like heartbeat/security-alert. Mounted
 * directly on `app` in app.ts via `.route("/api/v1/device",
 * appUsageDeviceRoutes())`, outside `/rpc` and outside tenantMiddleware() —
 * see the module's "API surface" note in the plan for why this must sit
 * ABOVE the `/api/v1/*` maintenance/read-only gate.
 */
export function appUsageDeviceRoutes() {
  return new Hono<{ Variables: DeviceAuthVars }>()
    .post(
      "/app-usage/events",
      requireDeviceBearerAuth(),
      zValidator("json", reportAppUsageEventsSchema),
      async (c) => {
        const device = c.var.device;
        const input = c.req.valid("json");

        const retryAfter = await deviceAppUsageLimiter.blockedFor(device.deviceId);
        if (retryAfter !== null) {
          return c.json(
            { error: "Too many app-usage events reported by this device. Try again later." },
            429,
            { "Retry-After": String(retryAfter) },
          );
        }

        // No station to attribute the event to — never silently misattribute.
        if (!device.stationId) {
          throw new HttpError(409, "Device has no assigned station.");
        }
        const stationId = device.stationId;

        const result = await withTenant(device.tenantId, async (tx) => {
          // Resolved ONCE per request (not per event) — frozen at write time,
          // never re-resolved on the matching closed update (Schema section,
          // sessionId).
          const sessionId = await resolveActiveSessionId(tx, device.tenantId, stationId);

          let launchedAccepted = 0;
          for (const entry of input.launched) {
            const [inserted] = await tx
              .insert(chronoAppUsageEvent)
              .values({
                id: createId(),
                tenantId: device.tenantId,
                branchId: device.branchId,
                stationId,
                deviceId: device.deviceId,
                sessionId,
                runId: entry.runId,
                category: entry.category,
                appName: entry.appName,
                executablePath: entry.executablePath ?? null,
                startedAt: new Date(entry.startedAt),
                metadata: entry.metadata ?? null,
              })
              .onConflictDoNothing({
                target: [chronoAppUsageEvent.deviceId, chronoAppUsageEvent.runId],
              })
              .returning({ id: chronoAppUsageEvent.id });
            // Idempotent insert-if-absent: a retried launched payload for a
            // runId already on file is a no-op, not counted as accepted again.
            if (inserted) launchedAccepted++;
          }

          let closedApplied = 0;
          let closedSkipped = 0;
          for (const entry of input.closed) {
            const [existing] = await tx
              .select({
                startedAt: chronoAppUsageEvent.startedAt,
                endedAt: chronoAppUsageEvent.endedAt,
              })
              .from(chronoAppUsageEvent)
              .where(
                and(
                  eq(chronoAppUsageEvent.deviceId, device.deviceId),
                  eq(chronoAppUsageEvent.runId, entry.runId),
                ),
              )
              .limit(1);

            // Out-of-order delivery across requests — dropped silently,
            // counted for device-side visibility, never a 500.
            if (!existing) {
              closedSkipped++;
              continue;
            }
            // Already closed — an idempotent retry of the same closed
            // payload. A genuine no-op: neither newly applied nor rejected.
            if (existing.endedAt !== null) {
              continue;
            }

            const endedAt = new Date(entry.endedAt);
            const durationSeconds = Math.floor(
              (endedAt.getTime() - existing.startedAt.getTime()) / 1000,
            );
            // Reject a skewed-clock / hostile pair, or one implying a run
            // longer than any real kiosk app ever runs — never let one bad
            // clock dominate the usage report.
            if (durationSeconds < 0 || durationSeconds > MAX_DURATION_SECONDS) {
              closedSkipped++;
              continue;
            }

            await tx
              .update(chronoAppUsageEvent)
              .set({
                endedAt,
                durationSeconds,
                closedReason: "device_closed",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chronoAppUsageEvent.deviceId, device.deviceId),
                  eq(chronoAppUsageEvent.runId, entry.runId),
                  isNull(chronoAppUsageEvent.endedAt),
                ),
              );
            closedApplied++;
          }

          return { launchedAccepted, closedApplied, closedSkipped };
        });

        await deviceAppUsageLimiter.record(device.deviceId);

        return c.json(result, 201);
      },
    );
}
