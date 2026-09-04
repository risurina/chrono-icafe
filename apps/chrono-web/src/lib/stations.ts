import { cache } from "react";
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

    const headers: Record<string, string> = {};
    if (t.slug) headers["x-tenant-slug"] = t.slug;
    else if (t.host) headers["x-tenant-host"] = t.host;

    try {
      const res = await fetch(`${API_URL}/public/stations`, {
        headers,
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
