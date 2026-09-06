import { Hono, type Context } from "hono";
import { withAdmin, schema as base, eq, and } from "agora/db";
import { createRateLimiter, clientIp } from "agora/server";
import { customerAuthMiddleware, type CustomerVars } from "agora/customer-auth";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "./schema";
import { toPublicStationStatus } from "./routes";
import type { MembershipVenueStatus, MembershipVenueStatusResponse } from "./contracts";

/**
 * Per-tenant live open/closed + availability for every business a signed-in
 * GLOBAL customer belongs to — the "My Gaming Spots" venue-list status
 * extension (member-portal-v2 plan Phase 7). This is a SECOND, additive read
 * the web page merges (by `tenantSlug`) with the foundation's own
 * `GET /portal/customer/memberships` (`agora/customer-auth`) — that route
 * stays business-neutral and is NOT edited here
 * (`.ai/rules/business-app.md`, "Extension seams"; the foundation never
 * carries one product's station/availability model). This route reuses the
 * same normaliser (`toPublicStationStatus`) and `{available, total}` bucket
 * shape Phase 3's `loadBranchAvailability` (`qr/public-routes.ts`) already
 * established.
 *
 * Cross-tenant by construction — one global customer, many tenants in ONE
 * response — so both reads go through `withAdmin` with an EXPLICIT tenantId
 * filter, never `withTenant` (no single active tenant context exists for a
 * global-customer session) and never a bare scan of an RLS-forced table
 * (`withAdmin`'s admin connection bypasses RLS, so the explicit filter below
 * is the only isolation on this path — same posture as
 * `readPublishedLandingPage`/`loadBranchAvailability`). Every `tenantId` used
 * to filter `ChronoStations`/`ChronoBranches` comes from the caller's own
 * ACTIVE `tenantMember` rows (resolved server-side from
 * `c.var.customer.customerId`), never from client input — a customer with no
 * membership in a tenant can never have that tenant's `tenantId` reach the
 * station query at all.
 */

const statusLimiter = createRateLimiter(30, 60 * 1000, "portal-membership-venue-status");

async function loadMembershipTenants(
  customerId: string,
): Promise<Array<{ tenantId: string; tenantSlug: string }>> {
  return withAdmin((tx) =>
    tx
      .select({ tenantId: base.organization.id, tenantSlug: base.organization.slug })
      .from(base.tenantMember)
      .innerJoin(base.organization, eq(base.tenantMember.tenantId, base.organization.id))
      .where(
        and(eq(base.tenantMember.customerId, customerId), eq(base.tenantMember.status, "active")),
      ),
  );
}

async function loadTenantVenueStatus(
  tenantId: string,
): Promise<Omit<MembershipVenueStatus, "tenantSlug">> {
  const rows = await withAdmin((tx) =>
    tx
      .select({ status: chronoStation.status })
      .from(chronoStation)
      .innerJoin(chronoBranch, eq(chronoStation.branchId, chronoBranch.id))
      .where(and(eq(chronoStation.tenantId, tenantId), eq(chronoBranch.status, "active"))),
  );
  const normalised = rows.map((r) => toPublicStationStatus(r.status));
  const available = normalised.filter((s) => s === "available").length;
  const reachable = normalised.filter((s) => s === "available" || s === "occupied").length;
  return {
    status: reachable > 0 ? "open" : "closed",
    available,
    total: normalised.length,
  };
}

export function stationMembershipStatusRoutes() {
  return new Hono().get(
    "/",
    customerAuthMiddleware(),
    async (c: Context<{ Variables: CustomerVars }>) => {
      const ip = clientIp(c) || "unknown";
      const retryAfter = await statusLimiter.blockedFor(ip);
      if (retryAfter !== null) {
        return c.json({ error: "Too many requests." }, 429, { "Retry-After": String(retryAfter) });
      }
      await statusLimiter.record(ip);

      const { customerId } = c.var.customer;
      const memberships = await loadMembershipTenants(customerId);
      const venues: MembershipVenueStatus[] = await Promise.all(
        memberships.map(async ({ tenantId, tenantSlug }) => ({
          tenantSlug,
          ...(await loadTenantVenueStatus(tenantId)),
        })),
      );
      const result: MembershipVenueStatusResponse = { venues };
      return c.json(result);
    },
  );
}
