import { Hono } from "hono";
import { withTenant, schema as base, eq, and, desc, asc, count } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoStation, chronoStationGroup } from "../station/schema";
import { chronoMemberProfile } from "../member/schema";
import { chronoWallet } from "../wallet/schema";
import { chronoSession } from "./schema";
import { closeSession } from "./service";
import { startSessionSchema, extendSessionSchema, sessionListQuerySchema } from "./contracts";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    startItem: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
    endItem: Math.min(page * pageSize, totalItems),
    sort,
    order,
  };
}

export function sessionRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    // GET is ungated beyond tenant membership — any tenant member can view
    // the board, matching project/branch/station's own GET convention.
    .get(
      "/sessions",
      zValidator("query", sessionListQuerySchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, branchId, stationId, memberId, status } =
          c.req.valid("query");
        const conds = [eq(chronoSession.tenantId, tenantId)];
        if (branchId) conds.push(eq(chronoSession.branchId, branchId));
        if (stationId) conds.push(eq(chronoSession.stationId, stationId));
        if (memberId) conds.push(eq(chronoSession.memberId, memberId));
        if (status) conds.push(eq(chronoSession.status, status));
        const where = and(...conds);
        const sortCol = sort === "startedAt" ? chronoSession.startedAt : chronoSession.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx.select({ value: count() }).from(chronoSession).where(where);
          const rows = await tx
            .select({
              id: chronoSession.id,
              branchId: chronoSession.branchId,
              stationId: chronoSession.stationId,
              stationName: chronoStation.name,
              stationNumber: chronoStation.stationNumber,
              memberId: chronoSession.memberId,
              memberName: base.tenantMember.name,
              memberEmail: base.tenantMember.email,
              status: chronoSession.status,
              startedAt: chronoSession.startedAt,
              scheduledEndAt: chronoSession.scheduledEndAt,
              pausedAt: chronoSession.pausedAt,
              endedAt: chronoSession.endedAt,
              rateSnapshot: chronoSession.rateSnapshot,
              rateSource: chronoSession.rateSource,
              finalAmount: chronoSession.finalAmount,
              amountCharged: chronoSession.amountCharged,
              createdAt: chronoSession.createdAt,
            })
            .from(chronoSession)
            .innerJoin(chronoStation, eq(chronoSession.stationId, chronoStation.id))
            .innerJoin(base.tenantMember, eq(chronoSession.memberId, base.tenantMember.id))
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .post("/sessions", zValidator("json", startSessionSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { session: ["create"] });
      const { tenantId, userId } = c.var.tenant;
      const input = c.req.valid("json");

      const created = await withTenant(tenantId, async (tx) => {
          const [station] = await tx
            .select()
            .from(chronoStation)
            .where(and(eq(chronoStation.id, input.stationId), eq(chronoStation.tenantId, tenantId)))
            .limit(1);
          if (!station) {
            throw new HttpError(404, "Station not found.");
          }
          if (station.status !== "available") {
            throw new HttpError(409, "STATION_OCCUPIED");
          }
          if (!station.stationGroupId) {
            throw new HttpError(
              400,
              "This station has no pricing group — assign one in Stations → Groups & Rates before starting a session.",
            );
          }
          const [group] = await tx
            .select()
            .from(chronoStationGroup)
            .where(eq(chronoStationGroup.id, station.stationGroupId))
            .limit(1);
          if (!group) {
            throw new HttpError(
              400,
              "This station has no pricing group — assign one in Stations → Groups & Rates before starting a session.",
            );
          }

          const [member] = await tx
            .select({ id: base.tenantMember.id })
            .from(base.tenantMember)
            .where(and(eq(base.tenantMember.id, input.memberId), eq(base.tenantMember.tenantId, tenantId)))
            .limit(1);
          if (!member) {
            throw new HttpError(404, "Member not found.");
          }
          const [tenantMemberRow] = await tx
            .select({ status: base.tenantMember.status })
            .from(base.tenantMember)
            .where(eq(base.tenantMember.id, input.memberId))
            .limit(1);
          if (tenantMemberRow?.status !== "active") {
            throw new HttpError(409, "This member's account is not active.");
          }

          // Rate resolution: memberRate only if the group has one set AND the
          // customer holds an approved ChronoMemberProfiles row.
          let rateSnapshot = group.hourlyRate;
          let rateSource: "group_hourly" | "group_member" = "group_hourly";
          if (group.memberRate) {
            const [profile] = await tx
              .select({ applicationStatus: chronoMemberProfile.applicationStatus })
              .from(chronoMemberProfile)
              .where(eq(chronoMemberProfile.memberId, input.memberId))
              .limit(1);
            if (profile?.applicationStatus === "approved") {
              rateSnapshot = group.memberRate;
              rateSource = "group_member";
            }
          }

          const [wallet] = await tx
            .select({ balance: chronoWallet.balance })
            .from(chronoWallet)
            .where(eq(chronoWallet.memberId, input.memberId))
            .limit(1);
          const balance = wallet?.balance ?? "0.00";
          if (Number(balance) <= 0) {
            throw new HttpError(422, "Insufficient wallet balance to start a session.");
          }

          const scheduledEndAt = input.durationMinutes
            ? new Date(Date.now() + input.durationMinutes * 60_000)
            : null;

          let row;
          try {
            [row] = await tx
              .insert(chronoSession)
              .values({
                id: createId(),
                tenantId,
                branchId: station.branchId,
                stationId: station.id,
                memberId: input.memberId,
                startedByUserId: userId,
                status: "active",
                scheduledEndAt,
                rateSnapshot,
                rateSource,
              })
              .returning();
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw new HttpError(409, "STATION_OCCUPIED");
            }
            throw err;
          }

          await tx
            .update(chronoStation)
            .set({ status: "occupied", updatedAt: new Date() })
            .where(eq(chronoStation.id, station.id));

          return row;
        });

      await recordStaffAudit(c, {
        action: "session.started",
        targetType: "session",
        targetId: created!.id,
      });
      return c.json({ session: created }, 201);
    })

    .post("/sessions/:id/pause", async (c) => {
      requirePermission(c.var.tenant.permissions, { session: ["update"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoSession.id, status: chronoSession.status })
          .from(chronoSession)
          .where(and(eq(chronoSession.id, id), eq(chronoSession.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Session not found.");
        }
        if (existing.status !== "active") {
          throw new HttpError(409, "Session is not active.");
        }
        const [row] = await tx
          .update(chronoSession)
          .set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() })
          .where(eq(chronoSession.id, id))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "session.paused",
        targetType: "session",
        targetId: id,
      });
      return c.json({ session: updated });
    })

    .post("/sessions/:id/resume", async (c) => {
      requirePermission(c.var.tenant.permissions, { session: ["update"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(chronoSession)
          .where(and(eq(chronoSession.id, id), eq(chronoSession.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Session not found.");
        }
        if (existing.status !== "paused") {
          throw new HttpError(409, "Session is not paused.");
        }
        const elapsedPausedSeconds = existing.pausedAt
          ? Math.floor((Date.now() - existing.pausedAt.getTime()) / 1000)
          : 0;
        const [row] = await tx
          .update(chronoSession)
          .set({
            status: "active",
            pausedAt: null,
            pausedDurationSeconds: existing.pausedDurationSeconds + elapsedPausedSeconds,
            updatedAt: new Date(),
          })
          .where(eq(chronoSession.id, id))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "session.resumed",
        targetType: "session",
        targetId: id,
      });
      return c.json({ session: updated });
    })

    .post(
      "/sessions/:id/extend",
      zValidator("json", extendSessionSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { session: ["update"] });
        const { tenantId } = c.var.tenant;
        const id = c.req.param("id");
        const { minutes } = c.req.valid("json");

        const updated = await withTenant(tenantId, async (tx) => {
          const [existing] = await tx
            .select()
            .from(chronoSession)
            .where(and(eq(chronoSession.id, id), eq(chronoSession.tenantId, tenantId)))
            .limit(1);
          if (!existing) {
            throw new HttpError(404, "Session not found.");
          }
          if (existing.status === "ended") {
            throw new HttpError(409, "Session has already ended.");
          }
          const base_ = existing.scheduledEndAt ?? new Date();
          const scheduledEndAt = new Date(base_.getTime() + minutes * 60_000);
          const [row] = await tx
            .update(chronoSession)
            .set({ scheduledEndAt, updatedAt: new Date() })
            .where(eq(chronoSession.id, id))
            .returning();
          return row;
        });

        await recordStaffAudit(c, {
          action: "session.extended",
          targetType: "session",
          targetId: id,
          metadata: { minutes },
        });
        return c.json({ session: updated });
      },
    )

    .post("/sessions/:id/end", async (c) => {
      requirePermission(c.var.tenant.permissions, { session: ["update"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");

      const result = await withTenant(tenantId, (tx) =>
        closeSession(tx, { tenantId, sessionId: id, performedByUserId: userId }),
      );

      if (!result.alreadyClosed) {
        await recordStaffAudit(c, {
          action: "session.ended",
          targetType: "session",
          targetId: result.session.id,
          metadata: {
            finalAmount: result.session.finalAmount,
            amountCharged: result.session.amountCharged,
          },
        });
      }
      return c.json(result);
    });
}
