import { hc } from "hono/client";
import { adminFetch } from "agora/client";
import type { AppType } from "@agora/chrono-api/app";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * Typed Hono client for the platform admin surface (`/rpc-admin`). The fetch
 * implementation (the `x-platform-admin` preflight header + security-policy
 * lockout redirect) is the foundation's `adminFetch()` (`agora/client`); this
 * file only binds the app's own `AppType` and API URL.
 */
export const adminApi = hc<AppType>(API_URL, { fetch: adminFetch() });
