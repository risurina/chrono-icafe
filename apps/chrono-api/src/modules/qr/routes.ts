import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { withTenant, eq, and } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoStation } from "../station/schema";
import { mintStationQrToken } from "./token";
import { QR_TOKEN_TTL_SECONDS, type StationQrStatus } from "./contracts";

/** Fresh, random per-station signing secret — never derived, never reused. */
function generateQrSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Staff-facing QR management, mounted under `/rpc/stations/:id/qr` — reuses
 * `station:["update"]` (no new permission resource, qr plan Open Question 4's
 * stated default). Composed into `rpc`, which already applies
 * `tenantMiddleware()` before this router is mounted, so no own middleware
 * here — mirrors `stationRoutes()`/`staffDeviceRoutes()`.
 */
export function stationQrRoutes() {
  return new Hono<{ Variables: TenantVars }>().post("/stations/:id/qr/regenerate", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { station: ["update"] });
    const id = c.req.param("id");

    const newSecret = generateQrSecret();

    const updated = await withTenant(tenantId, async (tx) => {
      const [station] = await tx
        .select({
          id: chronoStation.id,
          qrSecretVersion: chronoStation.qrSecretVersion,
        })
        .from(chronoStation)
        .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
        .limit(1);
      if (!station) {
        throw new HttpError(404, "Station not found.");
      }

      const nextVersion = station.qrSecretVersion + 1;
      const [row] = await tx
        .update(chronoStation)
        .set({ qrSecret: newSecret, qrSecretVersion: nextVersion, updatedAt: new Date() })
        .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
        .returning({
          id: chronoStation.id,
          qrSecret: chronoStation.qrSecret,
          qrSecretVersion: chronoStation.qrSecretVersion,
        });
      return row;
    });
    if (!updated || !updated.qrSecret) {
      throw new HttpError(404, "Station not found.");
    }

    const now = Date.now();
    const token = mintStationQrToken(
      { id: updated.id, qrSecret: updated.qrSecret, qrSecretVersion: updated.qrSecretVersion },
      now,
    );

    await recordStaffAudit(c, {
      action: "chronoStationQr.regenerated",
      targetType: "station",
      targetId: updated.id,
    });

    const result: StationQrStatus = {
      stationId: updated.id,
      qrSecretVersion: updated.qrSecretVersion,
      token,
      qrUrl: `/q/${token}`,
      expiresAt: new Date(now + QR_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
    return c.json(result);
  });
}
