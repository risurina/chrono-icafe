/**
 * Shared realtime publish helpers — the one place `branch.summary` is
 * computed, so the two call sites that trigger it (station create/update,
 * device approve) can never compute it differently.
 *
 * See `.ai/plans/chrono/active/realtime-updates/README.md`, Phase 2a.
 */

import { eq, and, type TenantTx } from "agora/db";
import { chronoStation } from "../station/schema";
import {
  chronoStationStatusSchema,
  type BranchSummaryEvent,
} from "./contracts";

/**
 * Counts `chronoStation` rows by status for one branch, inside the passed
 * transaction (never a fresh `withTenant` call — this must compose inside
 * the caller's own transaction so the count reflects the write that just
 * committed within it).
 */
export async function computeBranchSummary(
  tx: TenantTx,
  branchId: string,
): Promise<BranchSummaryEvent> {
  const rows = await tx
    .select({ status: chronoStation.status })
    .from(chronoStation)
    .where(and(eq(chronoStation.branchId, branchId)));

  const counts = {
    available: 0,
    occupied: 0,
    maintenance: 0,
    offline: 0,
  };
  for (const row of rows) {
    const parsed = chronoStationStatusSchema.safeParse(row.status);
    if (parsed.success) counts[parsed.data] += 1;
  }

  return {
    branchId,
    counts,
    total: rows.length,
  };
}
