/**
 * The apex host, and absolute URLs onto it.
 *
 * Env-only and free of `next/headers`, so this is safe to import from both
 * server and client components — unlike `@/lib/tenant`. Uses the same
 * `NEXT_PUBLIC_APP_DOMAIN` every other cross-host link in this app is built
 * from (`post-auth.ts`).
 */
export const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

/** `http` for local dev hosts, `https` everywhere else. */
export function protocolFor(host: string): "http" | "https" {
  return host.startsWith("localhost") || host.includes("localtest.me")
    ? "http"
    : "https";
}

/** An absolute URL on the apex (no tenant subdomain). */
export function apexUrl(path = "/"): string {
  return `${protocolFor(APP_DOMAIN)}://${APP_DOMAIN}${path}`;
}
