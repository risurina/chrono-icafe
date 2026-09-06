import { cache } from "react";
import {
  publicVenueInfoResponseSchema,
  type PublicVenueInfoResponse,
} from "@agora/chrono-api/branch";
import { getRequestTenant } from "@/lib/tenant";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type { PublicVenueInfoResponse };

/**
 * The tenant's real business info (contact, socials, map link) and its real
 * published rates, behind the landing page's business-info and rates sections.
 * `/public/venue-info` is host-resolved and IP-rate-limited.
 *
 * Re-validated against the API's own contract rather than trusted — the same
 * boundary discipline as `getTenantStations()` / `getTenantLanding()`. The
 * schema is imported, not redeclared: web apps here consume contracts, they
 * never author them.
 *
 * `null` when there is no tenant, the payload is malformed, or the API is
 * unreachable. Consumers must treat that as "no data" and render nothing —
 * never as a cue to fall back to placeholder rates, which is exactly the
 * fabrication this data exists to remove.
 */
export const getTenantVenueInfo = cache(
  async (): Promise<PublicVenueInfoResponse | null> => {
    const t = await getRequestTenant();
    if (!t.slug && !t.host) return null;

    const headers: Record<string, string> = {};
    if (t.slug) headers["x-tenant-slug"] = t.slug;
    else if (t.host) headers["x-tenant-host"] = t.host;

    try {
      const res = await fetch(`${API_URL}/public/venue-info`, {
        headers,
        cache: "no-store",
      });
      if (!res.ok) return null;
      const parsed = publicVenueInfoResponseSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
);
