import { hc } from "hono/client";
import type { AppType } from "@agora/api/app";
import { tenantFetch } from "agora/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * Typed Hono client for this app's API. `tenantFetch` (from the foundation)
 * sends the session cookie and the current tenant's headers on every request.
 */
export const api = hc<AppType>(API_URL, { fetch: tenantFetch() });
