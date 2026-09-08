import { Hono } from "hono";
import { withTenant, eq, and } from "agora/db";
import * as base from "agora/db/schema";
import { HttpError, zValidator, createRateLimiter } from "agora/server";
import { verifyMemberPassword } from "agora/member-auth";
import { chronoSession } from "../session/schema";
import { chronoWallet } from "../wallet/schema";
import { startSession, publishSessionTransition } from "../session/service";
import { deviceSessionStartSchema } from "./contracts";
import { requireDeviceBearerAuth, type DeviceAuthVars } from "./device-auth-middleware";

/**
 * Per-device bucket for the kiosk login -> session-start route below,
 * mirroring `routes.ts`'s `deviceSecurityAlertLimiter` pattern exactly
 * (`blockedFor(device.deviceId)` / `record(device.deviceId)` /
 * `clear(device.deviceId)`). A kiosk-forwarded login shares one IP across
 * every customer at that station, so the per-account bucket the underlying
 * `tenantMember` password-verify path would normally rely on
 * (`member-auth/index.ts`'s own `loginLimiter`, 5/15min per account+IP) is
 * not enough on its own here — a run of wrong guesses for ONE customer must
 * not lock out the NEXT unrelated customer who walks up to the same PC. Set
 * higher than that per-account number (20 vs. 5) since this bucket is shared
 * across every distinct customer who uses this station in the window, not
 * a single account.
 */
const deviceSessionLoginLimiter = createRateLimiter(20, 15 * 60 * 1000, "device-session-login");

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
    })

    // POST /session/start — kiosk login -> session start (Phase 5). A
    // customer standing at an already-approved kiosk enters their own
    // member email/password directly on the device; the device forwards it
    // here with its own bearer credential. tenantId/stationId come ONLY
    // from the authenticated device's own row (c.var.device) — never a body
    // field — so a compromised kiosk can only ever start a session on its
    // own station. `startSession`'s own `startedByUserId: null` marks this
    // as a self-service start, identical in shape to the member portal's
    // own QR self-service path (see `session/service.ts`'s doc comment).
    .post(
      "/session/start",
      requireDeviceBearerAuth(),
      zValidator("json", deviceSessionStartSchema),
      async (c) => {
        const device = c.var.device;
        // Not linked to a station (still pending_approval, or approved but
        // never relinked) — there is no station to start a session on.
        if (!device.stationId) {
          throw new HttpError(404, "This device is not linked to a station.");
        }
        const stationId = device.stationId;
        const { memberEmail, memberPassword } = c.req.valid("json");
        const email = memberEmail.toLowerCase();

        const retryAfter = await deviceSessionLoginLimiter.blockedFor(device.deviceId);
        if (retryAfter !== null) {
          return c.json(
            { error: "Too many login attempts from this device. Try again later." },
            429,
            { "Retry-After": String(retryAfter) },
          );
        }

        const [member] = await withTenant(device.tenantId, (tx) =>
          tx
            .select()
            .from(base.tenantMember)
            .where(
              and(
                eq(base.tenantMember.tenantId, device.tenantId),
                eq(base.tenantMember.email, email),
              ),
            )
            .limit(1),
        );

        // Wrong email, wrong password, or an inactive account all collapse
        // to the same generic 401 — never leak which field was wrong or
        // whether the account exists.
        if (
          !member ||
          member.status !== "active" ||
          !(await verifyMemberPassword(memberPassword, member.passwordHash))
        ) {
          await deviceSessionLoginLimiter.record(device.deviceId);
          throw new HttpError(401, "Incorrect email or password.");
        }
        await deviceSessionLoginLimiter.clear(device.deviceId);

        const created = await withTenant(device.tenantId, (tx) =>
          startSession(tx, {
            tenantId: device.tenantId,
            stationId,
            memberId: member.id,
            startedByUserId: null,
          }),
        );

        // Publish AFTER the transaction commits, never from inside it —
        // mirrors every other `startSession` call site (`session/routes.ts`)
        // and the wallet.low publish-after-commit fix (c57e8799).
        await publishSessionTransition(device.tenantId, created!);

        return c.json({ session: created }, 201);
      },
    );
}
