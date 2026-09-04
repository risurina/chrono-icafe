import { Hono } from "hono";
import {
  withTenant,
  eq,
  and,
  asc,
  desc,
  count,
  gte,
  lte,
  inArray,
  isNotNull,
  not,
  sql,
  type TenantTx,
} from "agora/db";
import * as base from "agora/db/schema";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoReservation } from "./schema";
import { chronoReservationPolicy } from "./policy-schema";
import { chronoMemberReservationRestriction } from "./restriction-schema";
import {
  createReservationSchema,
  updateReservationSchema,
  cancelReservationSchema,
  reservationListQuerySchema,
  updateReservationPolicySchema,
} from "./contracts";
import { resolveReservationPolicy } from "./service";
import { listQuerySchema } from "agora";
import { z } from "zod";

/**
 * Statuses that occupy a station and therefore participate in the overlap check.
 * "hold" was added by the reservations-queue-and-self-service plan — a live claim
 * window (post-activation direct reservation, or a promoted queue member) locks the
 * station exactly like "confirmed"/"checked_in" and must not be double-bookable.
 */
const ACTIVE_STATUSES = ["confirmed", "checked_in", "hold"] as const;

const OVERLAP_MESSAGE = "This station is already booked for the requested time.";

/**
 * The real double-booking guarantee is the `chrono_reservation_no_overlap`
 * Postgres EXCLUDE constraint (schema.ts) — `assertNoOverlap`'s
 * `SELECT ... FOR UPDATE` pre-check below is a friendly fail-fast optimization
 * only; it cannot serialize against a row that does not exist yet (audit-
 * remediation Phase 2). A concurrent insert/update that slips past the
 * pre-check is rejected by the constraint with Postgres error code `23P01`
 * (exclusion_violation) — map it to the same 409 the pre-check throws.
 */
function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23P01"
  );
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

/** Resolve a branch inside the caller's own tenant, or 404 (never a leaked cross-tenant signal). */
async function requireOwnBranch(tx: TenantTx, tenantId: string, branchId: string) {
  const [branch] = await tx
    .select({ id: chronoBranch.id })
    .from(chronoBranch)
    .where(and(eq(chronoBranch.id, branchId), eq(chronoBranch.tenantId, tenantId)))
    .limit(1);
  if (!branch) {
    throw new HttpError(404, "Branch not found.");
  }
}

/**
 * Resolve a station inside the caller's own tenant AND the given branch, or
 * 404 — mirrors station/routes.ts's requireOwnGroupInBranch. A stationId that
 * belongs to the tenant but a DIFFERENT branch than the one being booked is a
 * 400 (client bug — a station belongs to exactly one branch), never a 409.
 */
async function requireOwnStationInBranch(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  stationId: string,
) {
  const [station] = await tx
    .select({ id: chronoStation.id, branchId: chronoStation.branchId })
    .from(chronoStation)
    .where(and(eq(chronoStation.id, stationId), eq(chronoStation.tenantId, tenantId)))
    .limit(1);
  if (!station) {
    throw new HttpError(404, "Station not found.");
  }
  if (station.branchId !== branchId) {
    throw new HttpError(400, "This station does not belong to the given branch.");
  }
}

/** Resolve a tenant member inside the caller's own tenant, or 404. */
async function requireOwnMember(tx: TenantTx, tenantId: string, memberId: string) {
  const [member] = await tx
    .select({ id: base.tenantMember.id })
    .from(base.tenantMember)
    .where(and(eq(base.tenantMember.id, memberId), eq(base.tenantMember.tenantId, tenantId)))
    .limit(1);
  if (!member) {
    throw new HttpError(404, "Member not found.");
  }
}

/**
 * Locks every OTHER active (confirmed/checked_in) reservation row for this
 * station, then checks the requested [startAt, endAt) window against each
 * locked row's window in application code. Throws 409 on any overlap.
 * `excludeReservationId` is passed on update so a reservation never
 * conflicts with itself. This is the module's single load-bearing
 * correctness mechanism (see the reservations plan's "Overlap concurrency"
 * section) — mirrors the row-lock-then-validate discipline `pos`'s
 * `lockAndValidateProducts` and `shifts`' partial-unique-index backstop both
 * established, applied here to a time range instead of a counter/equality
 * check.
 */
async function assertNoOverlap(
  tx: TenantTx,
  args: {
    tenantId: string;
    stationId: string;
    startAt: Date;
    endAt: Date;
    excludeReservationId?: string;
  },
): Promise<void> {
  const { tenantId, stationId, startAt, endAt, excludeReservationId } = args;
  const conds = [
    eq(chronoReservation.tenantId, tenantId),
    eq(chronoReservation.stationId, stationId),
    inArray(chronoReservation.status, [...ACTIVE_STATUSES]),
    // A "pending" queue row is never in ACTIVE_STATUSES, but startAt/endAt are
    // now nullable at the column level (queue rows) — keep this guard explicit
    // rather than relying on that alone, and it's what lets the loop below
    // narrow away the `Date | null` type safely.
    isNotNull(chronoReservation.startAt),
  ];
  const locked = await tx
    .select({
      id: chronoReservation.id,
      startAt: chronoReservation.startAt,
      endAt: chronoReservation.endAt,
    })
    .from(chronoReservation)
    .where(and(...conds))
    .for("update");

  for (const row of locked) {
    if (excludeReservationId && row.id === excludeReservationId) continue;
    if (!row.startAt || !row.endAt) continue; // narrows Date | null for tsc
    // [startAt, endAt) overlap test.
    if (startAt < row.endAt && endAt > row.startAt) {
      throw new HttpError(409, OVERLAP_MESSAGE);
    }
  }
}

export function reservationRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get(
      "/reservations",
      zValidator("query", reservationListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { reservation: ["read"] });
        const { tenantId } = c.var.tenant;
        const {
          page,
          pageSize,
          sort,
          order,
          branchId,
          stationId,
          status,
          memberId,
          from,
          to,
        } = c.req.valid("query");

        const conds = [];
        if (branchId) conds.push(eq(chronoReservation.branchId, branchId));
        if (stationId) conds.push(eq(chronoReservation.stationId, stationId));
        if (status) {
          conds.push(eq(chronoReservation.status, status));
        } else {
          // Default-exclude queue entries — a "pending" row has no scheduled window
          // for the staff board to display. Phase 2 (contracts) adds "pending" to
          // reservationStatusSchema so a caller can explicitly opt in via ?status=pending;
          // until then this hardcoded exclusion is the only way to see queue rows here.
          conds.push(not(eq(chronoReservation.status, "pending")));
        }
        if (memberId) conds.push(eq(chronoReservation.memberId, memberId));
        // Board view: reservations overlapping [from, to).
        if (from) conds.push(gte(chronoReservation.endAt, new Date(from)));
        if (to) conds.push(lte(chronoReservation.startAt, new Date(to)));
        const where = conds.length ? and(...conds) : undefined;

        const sortCol =
          sort === "startAt" ? chronoReservation.startAt : chronoReservation.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoReservation)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoReservation)
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

    .get("/reservations/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { reservation: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoReservation)
          .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
          .limit(1),
      );
      if (!row) {
        throw new HttpError(404, "Reservation not found.");
      }
      return c.json({ reservation: row });
    })

    .post("/reservations", zValidator("json", createReservationSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { reservation: ["manage"] });
      const { tenantId, userId } = c.var.tenant;
      const input = c.req.valid("json");
      const startAt = new Date(input.startAt);
      const endAt = new Date(input.endAt);

      let created;
      try {
        created = await withTenant(tenantId, async (tx) => {
          await requireOwnBranch(tx, tenantId, input.branchId);
          await requireOwnStationInBranch(tx, tenantId, input.branchId, input.stationId);
          if (input.memberId) {
            await requireOwnMember(tx, tenantId, input.memberId);
          }
          await assertNoOverlap(tx, {
            tenantId,
            stationId: input.stationId,
            startAt,
            endAt,
          });
          const [row] = await tx
            .insert(chronoReservation)
            .values({
              id: createId(),
              tenantId,
              branchId: input.branchId,
              stationId: input.stationId,
              memberId: input.memberId,
              customerName: input.customerName,
              customerPhone: input.customerPhone,
              startAt,
              endAt,
              notes: input.notes,
              createdByUserId: userId,
            })
            .returning();
          return row;
        });
      } catch (err) {
        if (isExclusionViolation(err)) {
          throw new HttpError(409, OVERLAP_MESSAGE);
        }
        throw err;
      }

      await recordStaffAudit(c, {
        action: "chronoReservation.created",
        targetType: "reservation",
        targetId: created?.id,
        targetLabel: created?.customerName ?? created?.memberId ?? undefined,
        metadata: {
          stationId: created?.stationId,
          startAt: created?.startAt?.toISOString(),
          endAt: created?.endAt?.toISOString(),
        },
      });
      return c.json({ reservation: created }, 201);
    })

    .patch(
      "/reservations/:id",
      zValidator("json", updateReservationSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { reservation: ["manage"] });
        const { tenantId } = c.var.tenant;
        const id = c.req.param("id");
        const input = c.req.valid("json");

        let updated;
        try {
          updated = await withTenant(tenantId, async (tx) => {
            const [existing] = await tx
              .select()
              .from(chronoReservation)
              .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
              .limit(1);
            if (!existing) {
              throw new HttpError(404, "Reservation not found.");
            }
            if (existing.status !== "confirmed") {
              throw new HttpError(
                409,
                "This reservation can no longer be edited (it is not in a confirmed state).",
              );
            }
            // A "confirmed" status guarantees a concrete window in practice (only a
            // "pending" queue row has a NULL window), but narrow explicitly for tsc —
            // startAt/endAt are Date | null at the column level since the
            // reservations-queue-and-self-service plan.
            if (!existing.startAt || !existing.endAt) {
              throw new HttpError(409, "This reservation has no scheduled time to edit.");
            }

            const nextStationId = input.stationId ?? existing.stationId;
            if (input.stationId) {
              await requireOwnStationInBranch(tx, tenantId, existing.branchId, input.stationId);
            }
            const nextStartAt = input.startAt ? new Date(input.startAt) : existing.startAt;
            const nextEndAt = input.endAt ? new Date(input.endAt) : existing.endAt;

            if (input.stationId || input.startAt || input.endAt) {
              await assertNoOverlap(tx, {
                tenantId,
                stationId: nextStationId,
                startAt: nextStartAt,
                endAt: nextEndAt,
                excludeReservationId: id,
              });
            }

            const [row] = await tx
              .update(chronoReservation)
              .set({
                ...(input.stationId !== undefined && { stationId: input.stationId }),
                ...(input.startAt !== undefined && { startAt: nextStartAt }),
                ...(input.endAt !== undefined && { endAt: nextEndAt }),
                ...(input.notes !== undefined && { notes: input.notes }),
                updatedAt: new Date(),
              })
              .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
              .returning();
            return row;
          });
        } catch (err) {
          if (isExclusionViolation(err)) {
            throw new HttpError(409, OVERLAP_MESSAGE);
          }
          throw err;
        }

        await recordStaffAudit(c, {
          action: "chronoReservation.updated",
          targetType: "reservation",
          targetId: updated?.id,
          targetLabel: updated?.customerName ?? updated?.memberId ?? undefined,
          metadata: {
            stationId: updated?.stationId,
            startAt: updated?.startAt?.toISOString(),
            endAt: updated?.endAt?.toISOString(),
          },
        });
        return c.json({ reservation: updated });
      },
    )

    .post("/reservations/:id/check-in", async (c) => {
      requirePermission(c.var.tenant.permissions, { reservation: ["manage"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoReservation.id, status: chronoReservation.status })
          .from(chronoReservation)
          .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Reservation not found.");
        }
        if (existing.status !== "confirmed") {
          throw new HttpError(409, "Only a confirmed reservation can be checked in.");
        }
        const [row] = await tx
          .update(chronoReservation)
          .set({ status: "checked_in", checkedInAt: new Date(), updatedAt: new Date() })
          .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoReservation.checkedIn",
        targetType: "reservation",
        targetId: updated?.id,
        metadata: { stationId: updated?.stationId },
      });
      return c.json({ reservation: updated });
    })

    .post(
      "/reservations/:id/cancel",
      zValidator("json", cancelReservationSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { reservation: ["manage"] });
        const { tenantId } = c.var.tenant;
        const id = c.req.param("id");
        const { reason } = c.req.valid("json");

        const updated = await withTenant(tenantId, async (tx) => {
          const [existing] = await tx
            .select({ id: chronoReservation.id, status: chronoReservation.status })
            .from(chronoReservation)
            .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
            .limit(1);
          if (!existing) {
            throw new HttpError(404, "Reservation not found.");
          }
          if (["cancelled", "no_show", "completed"].includes(existing.status)) {
            throw new HttpError(409, "This reservation is already in a terminal state.");
          }
          const [row] = await tx
            .update(chronoReservation)
            .set({
              status: "cancelled",
              cancelledAt: new Date(),
              cancelReason: reason,
              updatedAt: new Date(),
            })
            .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
            .returning();
          return row;
        });

        await recordStaffAudit(c, {
          action: "chronoReservation.cancelled",
          targetType: "reservation",
          targetId: updated?.id,
          metadata: { stationId: updated?.stationId, reason },
        });
        return c.json({ reservation: updated });
      },
    )

    .post("/reservations/:id/no-show", async (c) => {
      requirePermission(c.var.tenant.permissions, { reservation: ["manage"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoReservation.id, status: chronoReservation.status })
          .from(chronoReservation)
          .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Reservation not found.");
        }
        if (existing.status !== "confirmed") {
          throw new HttpError(409, "Only a confirmed reservation can be marked as a no-show.");
        }
        const [row] = await tx
          .update(chronoReservation)
          .set({ status: "no_show", noShowAt: new Date(), updatedAt: new Date() })
          .where(and(eq(chronoReservation.id, id), eq(chronoReservation.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoReservation.noShow",
        targetType: "reservation",
        targetId: updated?.id,
        metadata: { stationId: updated?.stationId },
      });
      return c.json({ reservation: updated });
    })

    // --- reservations-queue-and-self-service plan: staff surface below ---

    // Resolved policy for a branch (or the tenant default when omitted) —
    // read tier matches booking (staff/admin/owner all read).
    .get("/reservations/policy", async (c) => {
      requirePermission(c.var.tenant.permissions, { reservation: ["read"] });
      const { tenantId } = c.var.tenant;
      const branchId = c.req.query("branchId");
      const policy = await withTenant(tenantId, (tx) =>
        resolveReservationPolicy(tx, tenantId, branchId ?? ""),
      );
      return c.json({ policy });
    })

    // Upserts the branch row (or the tenant-default row when branchId is
    // omitted) — config/override decision, admin+-only.
    .patch(
      "/reservations/policy",
      zValidator("json", updateReservationPolicySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { reservation: ["managePolicy"] });
        const { tenantId } = c.var.tenant;
        const branchId = c.req.query("branchId") ?? null;
        const parsed = c.req.valid("json");
        // Drizzle's numeric column type expects a string, matching every other
        // money column in this codebase (e.g. ChronoSessions.rateSnapshot).
        const input = { ...parsed, cancellationFeeAmount: String(parsed.cancellationFeeAmount) };

        const policy = await withTenant(tenantId, async (tx) => {
          if (branchId) {
            await requireOwnBranch(tx, tenantId, branchId);
          }
          const existing = await tx
            .select({ id: chronoReservationPolicy.id })
            .from(chronoReservationPolicy)
            .where(
              and(
                eq(chronoReservationPolicy.tenantId, tenantId),
                branchId
                  ? eq(chronoReservationPolicy.branchId, branchId)
                  : sql`${chronoReservationPolicy.branchId} is null`,
              ),
            )
            .limit(1);

          if (existing[0]) {
            const [row] = await tx
              .update(chronoReservationPolicy)
              .set({ ...input, updatedAt: new Date() })
              .where(eq(chronoReservationPolicy.id, existing[0].id))
              .returning();
            return row!;
          }
          const [row] = await tx
            .insert(chronoReservationPolicy)
            .values({ id: createId(), tenantId, branchId, ...input })
            .returning();
          return row!;
        });

        await recordStaffAudit(c, {
          action: "chronoReservationPolicy.updated",
          targetType: "reservationPolicy",
          targetId: policy.id,
          metadata: { branchId },
        });
        return c.json({ policy });
      },
    )

    // A member's restriction history — staff sees full detail (unlike the
    // member's own allowlisted portal view).
    .get(
      "/reservations/restrictions",
      zValidator("query", listQuerySchema(["createdAt"]).extend({ memberId: z.string().optional() })),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { reservation: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, memberId } = c.req.valid("query");
        const conds = [eq(chronoMemberReservationRestriction.tenantId, tenantId)];
        if (memberId) conds.push(eq(chronoMemberReservationRestriction.memberId, memberId));
        const where = and(...conds);
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoMemberReservationRestriction)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoMemberReservationRestriction)
            .where(where)
            .orderBy(sortFn(chronoMemberReservationRestriction.createdAt))
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

    // Lifts a wrongly-issued or no-longer-warranted ban — an append
    // (liftedAt/liftedByUserId), never a delete; history stays immutable.
    .post("/reservations/restrictions/:id/lift", async (c) => {
      requirePermission(c.var.tenant.permissions, { reservation: ["managePolicy"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(chronoMemberReservationRestriction)
          .where(
            and(
              eq(chronoMemberReservationRestriction.id, id),
              eq(chronoMemberReservationRestriction.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!existing) throw new HttpError(404, "Restriction not found.");
        if (existing.liftedAt) throw new HttpError(409, "This restriction has already been lifted.");
        if (existing.expiresAt && existing.expiresAt <= new Date()) {
          throw new HttpError(409, "This restriction has already expired.");
        }
        const [row] = await tx
          .update(chronoMemberReservationRestriction)
          .set({ liftedAt: new Date(), liftedByUserId: userId, updatedAt: new Date() })
          .where(eq(chronoMemberReservationRestriction.id, id))
          .returning();
        return row!;
      });

      await recordStaffAudit(c, {
        action: "chronoReservationRestriction.lifted",
        targetType: "reservationRestriction",
        targetId: updated.id,
        metadata: { memberId: updated.memberId, type: updated.type },
      });
      return c.json({ restriction: updated });
    });
}
