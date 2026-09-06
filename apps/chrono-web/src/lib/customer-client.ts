"use client";

import { tenantFetch } from "agora/client";
import type { MembershipVenueStatus } from "@agora/chrono-api/station";

// Global customer (platform-wide identity) auth for the browser. The
// transport client and the session hook both live in the foundation — this
// module stays as the app's single import point, mirroring member-client.ts.
export {
  customerAuth,
  applyForTenantMembership,
  getMyTenantMemberships,
  type GlobalCustomerUser,
  type GlobalCustomerMembership,
} from "agora/client";
export { useGlobalCustomerSession } from "agora/client/react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type { MembershipVenueStatus };

/**
 * Chrono-owned second read for "My Gaming Spots" (member-portal-v2 Phase 7)
 * — live open/closed + availability per venue, merged client-side (by
 * `tenantSlug`) with `getMyTenantMemberships()`'s foundation response. Kept
 * as its own request rather than folded into the foundation client because
 * the backing route (`/portal/customer/venues`) is Chrono-specific
 * (station/branch availability), not a foundation concern.
 */
export async function getMyVenueStatus(): Promise<{
  data: MembershipVenueStatus[] | null;
  error: string | null;
}> {
  const res = await tenantFetch()(`${API_URL}/portal/customer/venues`);
  const json = (await res.json().catch(() => null)) as
    | { venues?: MembershipVenueStatus[]; error?: string }
    | null;
  if (!res.ok) return { data: null, error: json?.error ?? "Request failed" };
  return { data: json?.venues ?? [], error: null };
}
