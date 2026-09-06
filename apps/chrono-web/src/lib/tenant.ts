// Read the tenant resolved by the foundation middleware (server components).
import { getRequestTenant } from "agora/next";

export { getRequestTenant };

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

/**
 * The current tenant host's own canonical absolute URL — for `og:url` and any
 * other absolute link a server-rendered public page needs. There is no request
 * protocol available server-side here, so it is derived from the host the same
 * way every other cross-host URL in this app is built from
 * `NEXT_PUBLIC_APP_DOMAIN` (`post-auth.ts`'s precedent).
 *
 * `null` on the apex, which has no tenant and therefore no tenant canonical.
 */
export async function getTenantCanonicalUrl(path = "/"): Promise<string | null> {
  const t = await getRequestTenant();
  const host = t.host ?? (t.slug ? `${t.slug}.${APP_DOMAIN}` : null);
  if (!host) return null;
  const isLocal = host.startsWith("localhost") || host.includes("localtest.me");
  return `${isLocal ? "http" : "https"}://${host}${path}`;
}
