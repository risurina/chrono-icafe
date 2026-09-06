import { cache } from "react";
import { headers } from "next/headers";
import {
  publicStationsResponseSchema,
  type PublicStationsResponse,
} from "@agora/chrono-api/station";
import { getRequestTenant } from "@/lib/tenant";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type { PublicStationsResponse };

/**
 * The public floor snapshot behind the hero's live gauges and the station
 * matrix. `/public/stations` is host-resolved, IP-rate-limited, and served from
 * a 10s server-side cache, so calling it on every render is cheap.
 *
 * Re-validated against the API's own contract rather than trusted — the same
 * boundary discipline as `getTenantLanding()`. The schema is imported, not
 * redeclared: web apps here consume contracts, they never author them.
 *
 * `null` when there is no tenant, the payload is malformed, or the API is
 * unreachable. Every consuming section treats that as "no live data" and
 * renders without it, so a floor-data outage cannot take the page down.
 */
export const getTenantStations = cache(
  async (): Promise<PublicStationsResponse | null> => {
    const t = await getRequestTenant();
    if (!t.slug && !t.host) return null;

    const outbound: Record<string, string> = {};
    if (t.slug) outbound["x-tenant-slug"] = t.slug;
    else if (t.host) outbound["x-tenant-host"] = t.host;

    // Forward the visitor's IP so the API's 20/min limiter buckets per client
    // instead of lumping every server-rendered page onto the "unknown" key —
    // the same forwarding `/api/public-stations` already does for the browser
    // poll. Phase 1A made this payload load-bearing for the hero gauges, so a
    // shared-bucket 429 would blank real content.
    const inbound = await headers();
    const xff = inbound.get("x-forwarded-for");
    if (xff) outbound["x-forwarded-for"] = xff;
    const realIp = inbound.get("x-real-ip");
    if (realIp) outbound["x-real-ip"] = realIp;

    try {
      const res = await fetch(`${API_URL}/public/stations`, {
        headers: outbound,
        cache: "no-store",
      });
      if (!res.ok) return null;
      const parsed = publicStationsResponseSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
);
