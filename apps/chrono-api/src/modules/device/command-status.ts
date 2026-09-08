import type { DeviceCommandStatus } from "./contracts";

/**
 * Lazy expiry-on-read for a device command (Phase 3,
 * `.ai/plans/chrono/in-progress/pc-client-tauri-api-integration/README.md`):
 * a `pending`/`delivered` command that has not been acked within its own
 * `expiresAt` is effectively "expired", even though its STORED `status`
 * column may still say `pending`/`delivered` — there is no background sweep/
 * cron in this first version, mirroring the lazy-resolution style already
 * used elsewhere in this codebase (e.g. `resolveTenantLimits`).
 *
 * Pure, no DB/IO — every place that surfaces a command's status to a caller
 * (a read/list route, the ack handler's own logging, a future UI) must go
 * through this helper rather than inlining a `Date.now()` comparison per
 * call site, so the expiry rule only ever lives in one place.
 */
export function getEffectiveCommandStatus(
  status: DeviceCommandStatus,
  expiresAt: Date,
  now: Date = new Date(),
): DeviceCommandStatus {
  const isPendingOrDelivered = status === "pending" || status === "delivered";
  if (isPendingOrDelivered && now.getTime() > expiresAt.getTime()) {
    return "expired";
  }
  return status;
}
