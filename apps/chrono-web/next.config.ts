import type { NextConfig } from "next";
import { version } from "./package.json";
import { withSentryConfig } from "@sentry/nextjs";

// The apex hostname, escaped for use in a rewrite `host` regex. Next strips the
// port before matching `has`/`missing` host conditions, so the pattern must be
// port-less ("localtest.me", not "localtest.me:3000") or it never matches and
// the rewrite would fire on the apex too. Everything that ISN'T this host — a
// tenant subdomain or a verified custom domain alike — gets the tenant-admin
// rewrite below.
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";
const APP_HOSTNAME = APP_DOMAIN.split(":")[0] ?? APP_DOMAIN;
const APP_HOSTNAME_PATTERN = APP_HOSTNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Expose the app version to the client bundle so the sidebar can display it.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // Compile workspace packages from source (no prebuild step needed).
  transpilePackages: ["agora", "@agora/chrono-api"],
  typescript: { ignoreBuildErrors: false },
  // Tenants are served on subdomains of the app domain (acme.localtest.me:3000),
  // not localhost. Next dev otherwise 403s /_next/* for those origins, breaking
  // hydration. Allow the app domain + any tenant subdomain in dev.
  allowedDevOrigins: ["localtest.me", "*.localtest.me"],
  // Tenant-admin URLs are `/admin/*` on a business's own host (subdomain or
  // verified custom domain), aliasing the physical `(tenant-admin)/dashboard`
  // route tree — kept under a different folder name so it doesn't collide
  // with the apex-only platform admin surface, which already owns `/admin`
  // at the file-tree level (`(saas-admin)/admin`). Config-level URL aliasing
  // only — no middleware.ts, no request interception; tenant/auth
  // enforcement is unchanged (session checks in layouts + API-side RLS).
  // `/admin/login` is excluded here (matched by its own rule first) since it
  // is physically outside the session-gated dashboard layout.
  async rewrites() {
    const notApex = [
      { type: "host" as const, value: APP_HOSTNAME_PATTERN },
      { type: "host" as const, value: `www\\.${APP_HOSTNAME_PATTERN}` },
    ];
    return {
      beforeFiles: [
        {
          source: "/admin/login",
          missing: notApex,
          destination: "/staff-login",
        },
        {
          source: "/admin/:path*",
          missing: notApex,
          destination: "/dashboard/:path*",
        },
        // `/member` is the same apex-vs-tenant collision as `/admin` above,
        // solved the same way: the apex owns `/member` at the file-tree level
        // ((saas-member)/member, the global-customer portal), and the
        // tenant-member tree is kept under a different physical folder name
        // ((tenant-member)/player) so the two don't collide in Next's
        // filesystem-keyed route table. `missing: notApex` aliases tenant-host
        // `/member/*` to `/player/*`, mirroring the `/admin/*` -> `/dashboard/*`
        // rule immediately above.
        //
        // The five shared auth pages (login, sign-up, forgot, reset,
        // accept-invite) are excluded from the alias via a negative lookahead:
        // foundation-emailed links and OAuth-callback redirects point at
        // `/member/{login,...}` regardless of which host the recipient is on,
        // so those paths must keep resolving to the apex's
        // (saas-member)/member tree even on a tenant host, exactly like
        // `/admin/login` is excluded above.
        { source: "/member", missing: notApex, destination: "/player" },
        {
          source: "/member/:path((?!login|sign-up|forgot|reset|accept-invite).*)",
          missing: notApex,
          destination: "/player/:path",
        },
      ],
    };
  },
  // `/portal` is the old URL for the member/portal surface, now split into
  // `/member` on both hosts (apex: global-customer portal home; tenant:
  // member dashboard, aliased to `/player` above). These two blanket,
  // host-unconditioned redirects replace the old tenant-only `/portal` ->
  // `/member` split so every existing bookmark and every hardcoded
  // `/portal/*` link baked into `packages/agora` (password-reset and
  // accept-invite emails, OAuth-callback `next` targets) keeps working with
  // zero edits to the shared foundation. Query strings survive the redirect
  // (`?token=`, `?error=`, `?next=`). Not a rewrite: the browser URL itself
  // must change here, per the plan.
  async redirects() {
    return [
      { source: "/portal", destination: "/member", permanent: false },
      { source: "/portal/:path*", destination: "/member/:path*", permanent: false },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  // Source-map upload is opt-in via SENTRY_AUTH_TOKEN; without it this is a no-op
  // build-time wrapper only (no auth, no upload attempted).
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
