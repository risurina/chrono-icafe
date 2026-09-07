/**
 * Builds the public URL of a listed business's own tenant host. The apex domain
 * is the same value the browser is already on, so the subdomain is derived from
 * `window.location.host` rather than a second env var.
 *
 * Extracted out of `discover/business-result-card.tsx` so every cross-subdomain
 * "go to this tenant" link (the discover card today, the lounge directory grid
 * in a later phase) shares one implementation instead of duplicating it.
 */
export function tenantHref(slug: string, source = "global_discovery"): string {
  if (typeof window === "undefined") return `/`;
  const { protocol, host } = window.location;
  // Strip a leading subdomain only if one is present (the apex may be
  // `chrono.example.com` or bare `localtest.me:3000`).
  // `?source=...` attributes the visit to this listing so the tenant page's
  // `TENANT_PAGE_VIEW` (and every downstream conversion event in the same
  // session) can be joined back to it — see `lib/analytics.ts`.
  return `${protocol}//${slug}.${host}?source=${source}`;
}
