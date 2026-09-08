import { Hono } from "hono";
import { withTenant, eq, and } from "agora/db";
import * as base from "agora/db/schema";
import { chronoSession } from "../session/schema";
import { chronoWallet } from "../wallet/schema";
import { requireDeviceBearerAuth, type DeviceAuthVars } from "./device-auth-middleware";

/**
 * Device-facing session/wallet status reads — Phase 4 of
 * `.ai/plans/chrono/in-progress/pc-client-tauri-api-integration/README.md`.
 * A cold-started kiosk's initial-state fetch on boot/reconnect, complementing
 * the realtime `session.state` / `wallet.low` pushes (`session/service.ts`'s
 * `publishSessionTransition`, `wallet/service.ts`'s `publishWalletLow`) which
 * only reach an already-open socket. NO Better Auth session and NO tenant
 * membership row — the device authenticates via `requireDeviceBearerAuth()`,
 * exactly like heartbeat/security-alert/app-usage. Mounted directly on `app`
 * in `app.ts` via `.route("/api/v1/device", deviceStatusRoutes())`, outside
 * `/rpc` and outside `tenantMiddleware()` — kept in its own file rather than
 * folded into `routes.ts` (905 lines already), mirroring how the realtime
 * websocket mount and `appUsageDeviceRoutes()` each get their own file.
 *
 * Both routes are scoped by the device's OWN `stationId`
 * (`resolveDeviceAuthContext`, on `c.var.device`) — NEVER a route param or
 * query string. This is true BY CONSTRUCTION: `device.stationId` is the only
 * station identifier either handler ever reads, so a compromised single
 * kiosk can never be pointed at another station's (and therefore another
 * customer's) session/wallet data, no matter what it sends.
 */
export function deviceStatusRoutes() {
  return new Hono<{ Variables: DeviceAuthVars }>()
    .get("/session/active", requireDeviceBearerAuth(), async (c) => {
      const device = c.var.device;
      // Not yet assigned to a station (still pending_approval, or approved
      // but never linked) — no station means no session to read. Not an
      // error: a kiosk mid-setup polls this before it has anything to show.
      if (!device.stationId) {
        return c.json({ session: null });
      }
      // Narrowed to a plain const so it stays `string` (not `string | null`)
      // once captured by the `withTenant` closure below — a property access
      // on `device` would not keep TS's narrowing across the closure boundary.
      const stationId = device.stationId;

      const [row] = await withTenant(device.tenantId, (tx) =>
        tx
          .select({
            id: chronoSession.id,
            memberId: chronoSession.memberId,
            memberName: base.tenantMember.name,
            status: chronoSession.status,
            startedAt: chronoSession.startedAt,
            scheduledEndAt: chronoSession.scheduledEndAt,
            pausedAt: chronoSession.pausedAt,
            rateSnapshot: chronoSession.rateSnapshot,
            currency: chronoSession.currency,
          })
          .from(chronoSession)
          .innerJoin(base.tenantMember, eq(chronoSession.memberId, base.tenantMember.id))
          .where(
            and(
              eq(chronoSession.tenantId, device.tenantId),
              eq(chronoSession.stationId, stationId),
              eq(chronoSession.status, "active"),
            ),
          )
          .limit(1),
      );

      // No active session is a normal state, not an error — mirrors the
      // member portal's own `GET /portal/sessions/active` convention.
      if (!row) return c.json({ session: null });

      return c.json({
        session: {
          id: row.id,
          memberId: row.memberId,
          memberName: row.memberName,
          status: row.status as "active",
          startedAt: row.startedAt.toISOString(),
          scheduledEndAt: row.scheduledEndAt ? row.scheduledEndAt.toISOString() : null,
          pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
          rateSnapshot: row.rateSnapshot,
          currency: row.currency,
        },
      });
    })

    .get("/wallet/balance", requireDeviceBearerAuth(), async (c) => {
      const device = c.var.device;
      if (!device.stationId) {
        return c.json({ balance: null });
      }
      const stationId = device.stationId;

      const wallet = await withTenant(device.tenantId, async (tx) => {
        const [session] = await tx
          .select({ memberId: chronoSession.memberId })
          .from(chronoSession)
          .where(
            and(
              eq(chronoSession.tenantId, device.tenantId),
              eq(chronoSession.stationId, stationId),
              eq(chronoSession.status, "active"),
            ),
          )
          .limit(1);
        // No active session -> no member context -> never guess a member.
        if (!session) return null;

        const [row] = await tx
          .select({ balance: chronoWallet.balance, currency: chronoWallet.currency })
          .from(chronoWallet)
          .where(eq(chronoWallet.memberId, session.memberId))
          .limit(1);
        // A member with no wallet row yet (never funded) reads as a real
        // zero balance, mirroring the staff `GET /wallets/:memberId`
        // convention, not a null/error.
        return row ?? { balance: "0.00", currency: "PHP" };
      });

      if (!wallet) return c.json({ balance: null });
      return c.json({ balance: wallet.balance, currency: wallet.currency });
    });
}
