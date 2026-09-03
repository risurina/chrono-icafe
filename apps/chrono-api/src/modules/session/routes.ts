import { Hono } from "hono";
import { withTenant, schema as base, eq, and, desc, asc, count } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoStation } from "../station/schema";
import { chronoSession } from "./schema";
import { closeSession, startSession, publishSessionTransition } from "./service";
import { startSessionSchema, extendSessionSchema, sessionListQuerySchema } from "./contracts";

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
              creditMinutesConsumed: chronoSession.creditMinutesConsumed,
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

      const created = await withTenant(tenantId, (tx) =>
        startSession(tx, {
          tenantId,
          stationId: input.stationId,
          memberId: input.memberId,
          durationMinutes: input.durationMinutes,
          startedByUserId: userId,
        }),
      );

      await publishSessionTransition(tenantId, created!);

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

      if (updated) await publishSessionTransition(tenantId, updated);

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

      if (updated) await publishSessionTransition(tenantId, updated);

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

        if (updated) await publishSessionTransition(tenantId, updated);

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
        await publishSessionTransition(tenantId, result.session);

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
