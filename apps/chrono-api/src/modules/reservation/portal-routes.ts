import { Hono } from "hono";
import { withTenant, eq, and, isNull, sql, desc } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { HttpError, zValidator, clientIp } from "agora/server";
import { recordAudit } from "agora/audit";
import { chronoStation } from "../station/schema";
import { chronoReservation } from "./schema";
import { chronoMemberReservationRestriction } from "./restriction-schema";
import {
  createDirectReservationSchema,
  joinQueueSchema,
  cancelReservationSchema,
} from "./contracts";
import {
  resolveReservationPolicy,
  createDirectReservation,
  joinQueue,
  confirmHold,
  cancelReservation,
} from "./service";

/**
 * Member-facing reservation self-service — gated by `memberMiddleware()`
 * (tenantMember/portal session), NEVER `tenantMiddleware()`/
 * `requirePermission` (staff auth). Mounted `/portal/reservations`, mirroring
 * `/portal/wallet` / `/portal/sessions`.
 */
export function reservationPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())

    // The member's current active reservation/queue entry, if any, with a
    // computed queue position (count of earlier "pending" rows for the same
    // station — never stored, always derived).
    .get("/", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const active = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoReservation)
          .where(
            and(
              eq(chronoReservation.tenantId, tenantId),
              eq(chronoReservation.memberId, memberId),
              isNull(chronoReservation.createdByUserId),
              sql`${chronoReservation.status} in ('confirmed','hold','checked_in','pending')`,
            ),
          )
          .orderBy(desc(chronoReservation.createdAt))
          .limit(1),
      );
      const reservation = active[0] ?? null;
      if (!reservation || reservation.status !== "pending") {
        return c.json({ reservation, queuePosition: null });
      }
      const [{ value: position }] = await withTenant(tenantId, (tx) =>
        tx
          .select({ value: sql<number>`count(*)::int` })
          .from(chronoReservation)
          .where(
            and(
              eq(chronoReservation.tenantId, tenantId),
              eq(chronoReservation.stationId, reservation.stationId),
              eq(chronoReservation.status, "pending"),
              sql`${chronoReservation.createdAt} < ${reservation.createdAt}`,
            ),
          ),
      );
      return c.json({ reservation, queuePosition: position + 1 });
    })

    // Resolved policy for a station's branch — the UI needs this before
    // showing Reserve/Join Queue buttons and the cancel-confirmation dialog.
    .get("/policy", async (c) => {
      const { tenantId } = c.var.member;
      const stationId = c.req.query("stationId");
      if (!stationId) throw new HttpError(400, "stationId is required.");
      const [station] = await withTenant(tenantId, (tx) =>
        tx
          .select({ branchId: chronoStation.branchId })
          .from(chronoStation)
          .where(and(eq(chronoStation.id, stationId), eq(chronoStation.tenantId, tenantId)))
          .limit(1),
      );
      if (!station) throw new HttpError(404, "Station not found.");
      const policy = await withTenant(tenantId, (tx) =>
        resolveReservationPolicy(tx, tenantId, station.branchId),
      );
      return c.json({ policy });
    })

    // The member's own active restrictions — allowlisted (type/reason/
    // expiresAt only, never metadataJson/liftedAt/liftedByUserId).
    .get("/restrictions", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const rows = await withTenant(tenantId, (tx) =>
        tx
          .select({
            type: chronoMemberReservationRestriction.type,
            reason: chronoMemberReservationRestriction.reason,
            expiresAt: chronoMemberReservationRestriction.expiresAt,
          })
          .from(chronoMemberReservationRestriction)
          .where(
            and(
              eq(chronoMemberReservationRestriction.tenantId, tenantId),
              eq(chronoMemberReservationRestriction.memberId, memberId),
              sql`${chronoMemberReservationRestriction.type} in ('reservation_ban','queue_ban')`,
              sql`${chronoMemberReservationRestriction.expiresAt} > now()`,
              isNull(chronoMemberReservationRestriction.liftedAt),
            ),
          ),
      );
      return c.json({ restrictions: rows });
    })

    // Flow 1 — direct reservation.
    .post("/", zValidator("json", createDirectReservationSchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const input = c.req.valid("json");
      const reservation = await createDirectReservation({
        tenantId,
        memberId,
        stationId: input.stationId,
        startAt: new Date(input.startAt),
        durationMinutes: input.durationMinutes,
      });
      await recordAudit({
        tenantId,
        actorType: "member",
        actorId: memberId,
        ip: clientIp(c),
        action: "chronoReservation.created",
        targetType: "reservation",
        targetId: reservation.id,
        metadata: { stationId: reservation.stationId, startAt: reservation.startAt },
      });
      return c.json({ reservation }, 201);
    })

    // Flow 2 — join the queue.
    .post("/queue", zValidator("json", joinQueueSchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const input = c.req.valid("json");
      const reservation = await joinQueue({
        tenantId,
        memberId,
        stationId: input.stationId,
        durationMinutes: input.durationMinutes,
      });
      await recordAudit({
        tenantId,
        actorType: "member",
        actorId: memberId,
        ip: clientIp(c),
        action: "chronoReservation.queued",
        targetType: "reservation",
        targetId: reservation.id,
        metadata: { stationId: reservation.stationId },
      });
      return c.json({ reservation }, 201);
    })

    // Flow 2 Option B — schedule from a live hold (does not start play).
    .post("/:id/confirm", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const id = c.req.param("id");
      const reservation = await confirmHold({ tenantId, memberId, reservationId: id });
      await recordAudit({
        tenantId,
        actorType: "member",
        actorId: memberId,
        ip: clientIp(c),
        action: "chronoReservation.confirmed",
        targetType: "reservation",
        targetId: reservation.id,
      });
      return c.json({ reservation });
    })

    .post("/:id/cancel", zValidator("json", cancelReservationSchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const id = c.req.param("id");
      const input = c.req.valid("json");
      const { reservation, isLate, feeAmount } = await cancelReservation({
        tenantId,
        memberId,
        reservationId: id,
        reason: input.reason,
      });
      await recordAudit({
        tenantId,
        actorType: "member",
        actorId: memberId,
        ip: clientIp(c),
        action: isLate ? "chronoReservation.cancelledLate" : "chronoReservation.cancelled",
        targetType: "reservation",
        targetId: reservation.id,
        metadata: { isLate, feeAmount },
      });
      return c.json({ reservation, isLate, feeAmount });
    });
}
