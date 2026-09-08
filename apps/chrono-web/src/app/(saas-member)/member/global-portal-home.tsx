"use client";

import { useEffect, useState } from "react";
import {
  useGlobalCustomerSession,
  getMyTenantMemberships,
  getMyVenueStatus,
  type GlobalCustomerMembership,
  type MembershipVenueStatus,
} from "@/lib/customer-client";
import { listBusinessDirectory } from "@/lib/discover-client";
import type { BusinessDirectoryListItem } from "@agora/chrono-api/business-lead";
import { LoungeDirectoryCard } from "@/components/member/lounge-directory-card";

/**
 * Global customer account home — the "Gaming Lounge Directory". Every
 * reachable tenant is listed (not just ones the customer has joined); each
 * card shows "Enter Portal" for a tenant the customer already belongs to, or
 * "Apply to Join" otherwise. Applying happens on the tenant's own `/member`
 * (see apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx) —
 * no apex-side apply call.
 */
export function GlobalPortalHome() {
  const { customer } = useGlobalCustomerSession();
  const [memberships, setMemberships] = useState<GlobalCustomerMembership[] | null>(null);
  const [directory, setDirectory] = useState<BusinessDirectoryListItem[]>([]);
  const [directoryError, setDirectoryError] = useState(false);
  const [venueStatusBySlug, setVenueStatusBySlug] = useState<
    Record<string, MembershipVenueStatus>
  >({});

  useEffect(() => {
    let active = true;

    // Fetched in parallel; none of the three must block the others from
    // rendering. The directory list failing to load must not blank the page
    // — matches the pre-existing `getMyVenueStatus()` "absorb failure
    // silently" precedent this file already followed before this change.
    Promise.allSettled([
      getMyTenantMemberships(),
      // pageSize: 100 is the contract's max (listQuerySchema) — a stopgap so
      // the grid covers far more than the 10-item default. It still isn't
      // truly "every active tenant" once the platform exceeds 100; real
      // pagination/search on this page is a separate, unscoped follow-up.
      listBusinessDirectory({ pageSize: 100 }),
      getMyVenueStatus(),
    ]).then(([membershipsResult, directoryResult, venueStatusResult]) => {
      if (!active) return;

      if (membershipsResult.status === "fulfilled") {
        setMemberships(membershipsResult.value.data ?? []);
      } else {
        setMemberships([]);
      }

      if (directoryResult.status === "fulfilled" && directoryResult.value.ok) {
        setDirectory(directoryResult.value.items);
      } else {
        setDirectory([]);
        setDirectoryError(true);
      }

      if (venueStatusResult.status === "fulfilled" && venueStatusResult.value.data) {
        setVenueStatusBySlug(
          Object.fromEntries(venueStatusResult.value.data.map((v) => [v.tenantSlug, v])),
        );
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const memberSlugs = new Set((memberships ?? []).map((m) => m.tenantSlug));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{customer ? `, ${customer.name}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          One account, usable across every business you join.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Gaming Lounge Directory</h2>
          <p className="text-sm text-muted-foreground">
            Every active Chrono lounge. Enter the ones you&apos;ve joined, or apply to a
            new one.
          </p>
        </div>

        {directory.length === 0 && directoryError ? (
          <p className="text-sm text-muted-foreground">
            Could not load the directory right now. Please try again later.
          </p>
        ) : directory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lounges are listed yet.</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {directory.map((item) => (
              <LoungeDirectoryCard
                key={item.slug}
                name={item.name}
                slug={item.slug}
                status={item.status}
                isMember={memberSlugs.has(item.slug)}
                venueStatus={venueStatusBySlug[item.slug]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
