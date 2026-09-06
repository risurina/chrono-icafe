import { cache } from "react";
import { headers } from "next/headers";
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

    const outbound: Record<string, string> = {};
    if (t.slug) outbound["x-tenant-slug"] = t.slug;
    else if (t.host) outbound["x-tenant-host"] = t.host;

    // `/public/venue-info` is IP-rate-limited (20/min). Without forwarding the
    // visitor's IP, `clientIp()` on the API falls back to the constant
    // "unknown" and EVERY server-rendered landing page on the platform shares
    // one bucket — past 20 renders/min the fetch 429s and the rates + social
    // links silently vanish. Same forwarding the `/api/public-stations` route
    // handler already does.
    const inbound = await headers();
    const xff = inbound.get("x-forwarded-for");
    if (xff) outbound["x-forwarded-for"] = xff;
    const realIp = inbound.get("x-real-ip");
    if (realIp) outbound["x-real-ip"] = realIp;

    try {
      const res = await fetch(`${API_URL}/public/venue-info`, {
        headers: outbound,
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
