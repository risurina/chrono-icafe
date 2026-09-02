import type { MiddlewareHandler } from "hono";
import { eq } from "agora/db";
import { withAdmin } from "agora/db";
import { hashApiKey, verifyApiKey, HttpError } from "agora/server";
import { chronoDevice } from "./schema";

/**
 * Device-facing auth context — deliberately DISTINCT from `TenantVars`/
 * `c.var.tenant`. A device is not a human/session/API-key tenant actor and
 * must never accidentally satisfy a check written for one (Open Question 1).
 */
export type DeviceAuthContext = {
  deviceId: string;
  tenantId: string;
  branchId: string;
  stationId: string | null;
  status: "pending_approval" | "approved" | "revoked";
};

export type DeviceAuthVars = { device: DeviceAuthContext };

/**
 * The shared credential-check logic — extracted (realtime-updates plan,
 * Phase 3) so the websocket device actor resolver
 * (`realtime-actor.ts`'s `resolveDeviceActor`) can reuse the identical
 * lookup/verify/status check instead of duplicating it. Mirrors
 * `resolveApiKeyContext()`'s shape (`packages/agora/src/server/tenant.ts`):
 * parse credential -> cross-tenant `withAdmin` hash lookup -> verify ->
 * fingerprint check -> status check -> return a fresh context.
 *
 * Always re-reads the row — never cached — so an admin revoking/unapproving
 * a device is reflected on the very next call, whether that call is a REST
 * request or (Phase 3) a realtime connection's periodic re-validation tick.
 *
 * 401 for anything credential-shaped that fails (missing header, malformed,
 * unknown hash, fingerprint mismatch) — deliberately indistinguishable, never
 * reveals which check failed. 403 only once a credential is confirmed valid
 * but the matched device's own status isn't `approved`.
 */
export async function resolveDeviceAuthContext(c: {
  req: { header: (name: string) => string | undefined };
}): Promise<DeviceAuthContext> {
  const authHeader = c.req.header("authorization");
  const fingerprint = c.req.header("x-device-fingerprint");

  if (!authHeader || !fingerprint) {
    throw new HttpError(401, "Missing device credentials.");
  }
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "Missing device credentials.");
  }

  // ChronoDevices is RLS-forced and this runs before a tenant is known, so
  // the lookup must bypass RLS (single-connection safe via withAdmin). The
  // lookup is by the unique hash column itself, never a scan — this is the
  // ONLY step in the whole flow that legitimately reads across tenants.
  const tokenHash = hashApiKey(token);
  const [row] = await withAdmin((tx) =>
    tx.select().from(chronoDevice).where(eq(chronoDevice.tokenHash, tokenHash)).limit(1),
  );

  if (!row || !verifyApiKey(token, row.tokenHash) || row.deviceFingerprint !== fingerprint) {
    throw new HttpError(401, "Invalid device credentials.");
  }
  if (row.status !== "approved") {
    throw new HttpError(403, "Device is not approved.");
  }

  return {
    deviceId: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    stationId: row.stationId,
    status: row.status as DeviceAuthContext["status"],
  };
}

/**
 * Authenticates a device's own bearer credential directly against
 * `ChronoDevices`, independently of `tenantMiddleware()` — the tenant is not
 * known until after the credential is looked up (Open Question 1).
 */
export function requireDeviceBearerAuth(): MiddlewareHandler<{
  Variables: DeviceAuthVars;
}> {
  return async (c, next) => {
    const device = await resolveDeviceAuthContext(c);
    c.set("device", device);
    await next();
  };
}
