import type { NextConfig } from "next";
import { version } from "./package.json";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Expose the app version to the client bundle so the sidebar can display it.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // Compile workspace packages from source (no prebuild step needed).
  transpilePackages: ["agora"],
  typescript: { ignoreBuildErrors: false },
  // Tenants are served on subdomains of the app domain (acme.localtest.me:3000),
  // not localhost. Next dev otherwise 403s /_next/* for those origins, breaking
  // hydration. Allow the app domain + any tenant subdomain in dev.
  allowedDevOrigins: ["localtest.me", "*.localtest.me"],
};

export default withSentryConfig(nextConfig, {
  silent: true,
  // Source-map upload is opt-in via SENTRY_AUTH_TOKEN; without it this is a no-op
  // build-time wrapper only (no auth, no upload attempted).
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
