/**
 * Device-facing realtime websocket mount (`/api/v1/device/ws`) — the
 * `resolveActor` implementation and per-mount limits, per
 * `.ai/plans/chrono/active/realtime-updates/README.md` Phase 3.
 *
 * Reuses `resolveDeviceAuthContext` (`device-auth-middleware.ts`) — the
 * IDENTICAL credential lookup/verify/status check the REST device routes
 * use — rather than duplicating it. That function already throws
 * `HttpError(401, ...)` for any credential-shaped failure and
 * `HttpError(403, "Device is not approved.")` for a `pending_approval`/
 * `revoked` device, which is exactly the resolved "Open Question 1" behavior:
 * a non-approved device's connection is refused OUTRIGHT, before the
 * handshake completes, never a post-open close frame — `resolveActor` runs
 * inside `createRealtimeRoute`'s `createEvents`, before any handler is
 * returned (see `agora/realtime`'s own `ResolveActor` doc comment).
 *
 * Also re-reads `chronoDevice.status` fresh on EVERY call — never cached —
 * so a device revoked/unapproved mid-connection is caught by the periodic
 * `revalidateEveryMs` re-validation tick even if the fast-path
 * `closeConnections` call in a revoke/relink route is ever missed.
 */
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { withTenant, eq, and } from "agora/db";
import {
  createRealtimeRoute,
  type ResolveActor,
  type ResolvedActor,
  type RealtimeLimits,
} from "agora/realtime";
import { resolveDeviceAuthContext, type DeviceAuthVars } from "./device-auth-middleware";
import { chronoDevice, chronoDeviceCommand } from "./schema";
import { deviceCommandAckSchema } from "./contracts";
import { validateChronoDeviceScopes } from "../realtime/scope-validators";

/**
 * Resolves the device actor for one connection attempt, then — on success —
 * updates `connectivityStatus`/`lastSeenAt` as a side effect.
 *
 * DEVIATION, recorded rather than silently reinterpreted: the plan's Phase 3
 * text says to wire this "on each [30s protocol] ping", but
 * `agora/realtime`'s `createRealtimeRoute` exposes no hook into its
 * internal ws ping/pong heartbeat (it is fully encapsulated inside
 * `route.ts`, with no `onHeartbeat`/`onOpen` callback in
 * `CreateRealtimeRouteOptions`) — adding one would mean editing the shared
 * FOUNDATION transport file that also backs the staff mount, which is
 * explicitly out of scope for this phase. Instead, this updates the row
 * every time `resolveActor` itself runs successfully: once at the initial
 * connect, and again every `revalidateEveryMs` (5 minutes, below) via the
 * transport's own existing periodic re-validation timer. This is a coarser
 * cadence than a literal 30s heartbeat, but it is a real, working liveness
 * signal built entirely from mechanisms Phase 1/2 already shipped, and the
 * REST `/heartbeat` endpoint (unchanged, unremoved) still provides the
 * fine-grained cadence for a device that cannot hold a socket at all.
 */
export const resolveDeviceActor: ResolveActor = async (c): Promise<ResolvedActor> => {
  const device = await resolveDeviceAuthContext(c);

  const now = new Date();
  await withTenant(device.tenantId, (tx) =>
    tx
      .update(chronoDevice)
      .set({ lastSeenAt: now, connectivityStatus: "online", updatedAt: now })
      .where(and(eq(chronoDevice.id, device.deviceId), eq(chronoDevice.tenantId, device.tenantId))),
  );

  return { tenantId: device.tenantId, actorKey: device.deviceId };
};

/**
 * A kiosk agent is not a browser and sends no `Origin` header — the
 * foundation's staff mount rejects a missing Origin (CSWSH protection), which
 * would refuse every device. The compensating control is the bearer
 * credential itself: there is no ambient credential a browser could be
 * tricked into replaying cross-site, so CSWSH does not apply here.
 *
 * `maxLifetimeMs: 12h` is a nightly backstop (the foundation forbids `null` —
 * relying solely on `closeConnections` for revocation is a single point of
 * failure). `maxPerActor: 2` allows one live connection plus one reconnecting
 * without tripping the cap. Frame limits are deliberately small — a device
 * sends only its own status/ack, never a payload anywhere near staff-mount
 * size.
 */
export const CHRONO_DEVICE_REALTIME_LIMITS: RealtimeLimits = {
  maxLifetimeMs: 12 * 60 * 60 * 1000,
  revalidateEveryMs: 5 * 60 * 1000,
  heartbeatMs: 30_000,
  maxPerActor: 2,
  maxPerTenant: 1000,
  maxFrameBytes: 2 * 1024,
  inboundFramesPerMin: 30,
  requireOrigin: false,
};

/**
 * Handles one validated `{ type: "command-ack", commandId, result }` inbound
 * frame (Phase 3, device command dispatch). Looks the command up scoped by
 * BOTH `tenantId` (via `withTenant`) AND `deviceId` (`actor.actorKey`) in the
 * WHERE clause — mirroring `routes.ts`'s own `requireOwnDevice` pattern, so a
 * forged/stale `commandId` (wrong tenant, wrong device, or simply unknown)
 * can never be applied. Not found -> silently drop, exactly like the
 * existing `deviceId` self-check below (never close the connection over a
 * malformed/foreign ack).
 *
 * Async, so it is fired with `void` from the sync `onFrame` callback below —
 * the same "fire, don't await" shape `route.ts` already uses for its own
 * `resolveActor` re-validation timer.
 */
async function handleCommandAck(
  actor: ResolvedActor,
  ack: { commandId: string; result?: Record<string, unknown> },
): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const [command] = await tx
      .select({ id: chronoDeviceCommand.id })
      .from(chronoDeviceCommand)
      .where(
        and(
          eq(chronoDeviceCommand.id, ack.commandId),
          eq(chronoDeviceCommand.tenantId, actor.tenantId),
          eq(chronoDeviceCommand.deviceId, actor.actorKey),
        ),
      )
      .limit(1);
    if (!command) return; // Forged/stale commandId — drop, never applied.

    await tx
      .update(chronoDeviceCommand)
      .set({ status: "acked", ackedAt: new Date(), result: ack.result ?? null })
      .where(eq(chronoDeviceCommand.id, command.id));
  });
}

/**
 * The device realtime mount, `GET /ws` under wherever this is `.route()`d
 * (Chrono's `app.ts` mounts it at `/api/v1/device`, alongside — but as a
 * SEPARATE `.route()` call from — the existing `deviceAuthRoutes()` REST
 * mount, so neither file needs to know about the other's shape).
 *
 * `onFrame` enforces the one piece of inbound hardening this phase specifies:
 * a device reports only its OWN status/ack, so any frame naming a
 * `stationId`/`deviceId` other than the one this connection resolved to is
 * dropped — never relayed, never acted on. The first real inbound frame
 * TYPE, `command-ack` (Phase 3), is handled by `handleCommandAck` above; any
 * other/malformed frame is dropped with no error, matching the existing
 * "drop, don't fail" hardening style.
 */
export function deviceRealtimeRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono<{ Variables: DeviceAuthVars }>().get(
    "/ws",
    createRealtimeRoute({
      upgradeWebSocket,
      resolveActor: resolveDeviceActor,
      validateScopes: validateChronoDeviceScopes,
      limits: CHRONO_DEVICE_REALTIME_LIMITS,
      onFrame: ({ actor, data }) => {
        if (typeof data !== "object" || data === null) return;
        const frame = data as { deviceId?: unknown; stationId?: unknown; type?: unknown };
        if (typeof frame.deviceId === "string" && frame.deviceId !== actor.actorKey) {
          return; // Dropped: a device may only ever report on itself.
        }
        // stationId hardening is enforced the same way once an inbound
        // frame TYPE actually carries one — no such type carries one yet.

        if (frame.type === "command-ack") {
          const parsed = deviceCommandAckSchema.safeParse(data);
          if (!parsed.success) return; // Malformed ack — drop, don't crash the connection.
          void handleCommandAck(actor, parsed.data);
        }
      },
    }),
  );
}
