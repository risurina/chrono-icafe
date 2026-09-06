import { Hono } from "hono";
import { withTenant, schema as base, eq, and, asc, desc, count, ilike, inArray, type TenantTx } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator, resolveOrgFromRequest, createRateLimiter, clientIp } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoStation, chronoStationGroup } from "./schema";
import { chronoSession } from "../session/schema";
import { getRealtimeProvider, tenantScopeChannel } from "agora/realtime";
import { computeBranchSummary } from "../realtime/service";
import {
  chronoStationStatusSchema,
  type ChronoStationStatus,
  type StationStatusEvent,
} from "../realtime/contracts";
import {
  createStationSchema,
  updateStationSchema,
  createStationGroupSchema,
  updateStationGroupSchema,
  stationListQuerySchema,
  stationGroupListQuerySchema,
  stationBoardQuerySchema,
  type StationDto,
  type StationGroupDto,
  type PublicStationsResponse,
  type StationBoardStation,
} from "./contracts";

/** Explicit column list — never `qrSecret`/`qrSecretVersion` (`.ai/rules/dto.md`). */
const stationColumns = {
  id: chronoStation.id,
  tenantId: chronoStation.tenantId,
  branchId: chronoStation.branchId,
  stationGroupId: chronoStation.stationGroupId,
  name: chronoStation.name,
  stationNumber: chronoStation.stationNumber,
  stationType: chronoStation.stationType,
  status: chronoStation.status,
  locationZone: chronoStation.locationZone,
  specs: chronoStation.specs,
  createdAt: chronoStation.createdAt,
  updatedAt: chronoStation.updatedAt,
};

type StationRow = {
  id: string;
  tenantId: string;
  branchId: string;
  stationGroupId: string | null;
  name: string;
  stationNumber: string;
  stationType: string;
  status: string;
  locationZone: string | null;
  specs: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function toStationDto(row: StationRow): StationDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    stationGroupId: row.stationGroupId,
    name: row.name,
    stationNumber: row.stationNumber,
    stationType: row.stationType,
    status: row.status as StationDto["status"],
    locationZone: row.locationZone,
    specs: row.specs as StationDto["specs"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type StationBoardRow = {
  id: string;
  stationNumber: string;
  name: string;
  stationType: string;
  status: string;
  locationZone: string | null;
  stationGroupId: string | null;
  stationGroupName: string | null;
  sessionId: string | null;
  sessionMemberId: string | null;
  sessionMemberName: string | null;
  sessionStatus: string | null;
  sessionStartedAt: Date | null;
  sessionScheduledEndAt: Date | null;
  sessionPausedAt: Date | null;
};

/** Never a raw row — explicit projection per `.ai/rules/dto.md`. */
function toStationBoardDto(row: StationBoardRow): StationBoardStation {
  const hasActiveSession =
    row.sessionId !== null &&
    row.sessionMemberId !== null &&
    row.sessionMemberName !== null &&
    row.sessionStatus !== null &&
    row.sessionStartedAt !== null;

  return {
    id: row.id,
    stationNumber: row.stationNumber,
    name: row.name,
    stationType: row.stationType,
    status: row.status as StationBoardStation["status"],
    locationZone: row.locationZone,
    stationGroupId: row.stationGroupId,
    stationGroupName: row.stationGroupName,
    activeSession: hasActiveSession
      ? {
          id: row.sessionId!,
          memberId: row.sessionMemberId!,
          memberName: row.sessionMemberName!,
          status: row.sessionStatus as "active" | "paused",
          startedAt: row.sessionStartedAt!.toISOString(),
          scheduledEndAt: row.sessionScheduledEndAt?.toISOString() ?? null,
          pausedAt: row.sessionPausedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * Publishes `station.status` + the recomputed `branch.summary` for a station
 * that just transitioned (create/update). Called AFTER the write's own
 * `withTenant` transaction has committed — a publish is not transactional and
 * must not roll back with the write it announces. `computeBranchSummary` runs
 * in its own fresh `withTenant` read here, reflecting the just-committed
 * state (read-committed isolation is sufficient — this is a best-effort
 * announcement, the poll remains the source of truth).
 *
 * Shared by `station/routes.ts` and `device/routes.ts` (device-approve can
 * also create/link a station) so both call sites publish identically — see
 * `.ai/plans/chrono/active/realtime-updates/README.md`, Phase 2a.
 */
export async function publishStationTransition(
  tenantId: string,
  station: { id: string; branchId: string; status: string },
): Promise<void> {
  const parsedStatus = chronoStationStatusSchema.safeParse(station.status);
  if (!parsedStatus.success) return;

  const provider = getRealtimeProvider();
  await provider.publish(
    tenantScopeChannel(tenantId, `branch:${station.branchId}`),
    "station.status",
    {
      stationId: station.id,
      branchId: station.branchId,
      status: parsedStatus.data,
    } satisfies StationStatusEvent,
  );

  const summary = await withTenant(tenantId, (tx) =>
    computeBranchSummary(tx, station.branchId),
  );
  await provider.publish(
    tenantScopeChannel(tenantId, `branch-summary:${station.branchId}`),
    "branch.summary",
    summary,
  );
}

type StationGroupRow = {
  id: string;
  tenantId: string;
  branchId: string;
  name: string;
  code: string;
  description: string | null;
  hourlyRate: string;
  memberRate: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toStationGroupDto(row: StationGroupRow): StationGroupDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    name: row.name,
    code: row.code,
    description: row.description,
    hourlyRate: row.hourlyRate,
    memberRate: row.memberRate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && err.code === "23505"
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
 * Resolve a station group inside the caller's own tenant AND the station's own
 * branch, or 404. `withTenant` already scopes the SELECT to this tenant via
 * RLS, but the explicit `tenantId` filter matches this codebase's existing
 * defense-in-depth pattern (see `requireOwnBranch` above) rather than relying
 * on RLS alone. The `branchId` filter is the actual bug fix: without it, a
 * client could point a station at a group belonging to a different branch (or,
 * before RLS narrows it, a different tenant).
 */
async function requireOwnGroupInBranch(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  stationGroupId: string,
) {
  const [group] = await tx
    .select({ id: chronoStationGroup.id })
    .from(chronoStationGroup)
    .where(
      and(
        eq(chronoStationGroup.id, stationGroupId),
        eq(chronoStationGroup.tenantId, tenantId),
        eq(chronoStationGroup.branchId, branchId),
      ),
    )
    .limit(1);
  if (!group) {
    throw new HttpError(404, "Station group not found.");
  }
}

/**
 * `ChronoStations.status` is a free-text column, so the public read parses it
 * rather than casting. An unrecognised value degrades to "offline": a station we
 * cannot interpret must never be advertised as playable. Exported so the `qr`
 * module's `/public/qr/resolve` can normalise a station's status identically
 * (reused rather than reimplemented — see qr plan Phase 3 / member-portal-v2
 * plan Phase 3).
 */
export function toPublicStationStatus(status: string): ChronoStationStatus {
  const parsed = chronoStationStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : "offline";
}

// IP rate limiter: generous enough for polling (approx 1 req/3s) but bounded
const publicStationsLimiter = createRateLimiter(20, 60 * 1000, "public-stations");

// 5-10s in-memory cache keyed by tenantId to avoid a DB hit on every client poll
const publicStationsCache = new Map<
  string,
  { data: PublicStationsResponse; at: number }
>();

export function publicStationRoutes() {
  return new Hono()
    .use("*", async (c, next) => {
      // Abuse prevention: rate-limit by IP for this public route.
      const ip = clientIp(c) || "unknown";
      const retryAfter = await publicStationsLimiter.blockedFor(ip);
      if (retryAfter !== null) {
        return c.json({ error: "Too many requests." }, 429, { "Retry-After": String(retryAfter) });
      }
      await publicStationsLimiter.record(ip);
      await next();
    })
    .get("/", async (c) => {
      // 1. Resolve the tenant context using the host headers (no tenantMiddleware / session here).
      const org = await resolveOrgFromRequest(c);
      if (!org) {
        throw new HttpError(404, "Tenant not found.");
      }

      // Terminal status check: do not serve public data for suspended/cancelled/archived/deleting tenants.
      const status = org.status;
      if (
        status === "suspended" ||
        status === "cancelled" ||
        status === "archived" ||
        status === "deleting"
      ) {
        throw new HttpError(404, "Tenant not found.");
      }

      const tenantId = org.id;

      // 2. Read from cache if fresh (10s TTL)
      const now = Date.now();
      const cached = publicStationsCache.get(tenantId);
      if (cached && now - cached.at < 10000) {
        return c.json(cached.data);
      }

      // 3. Read branches + stations via withTenant (RLS enforced), grouped by branch.
      const data = await withTenant(tenantId, async (tx) => {
        // Only active branches show on the live public page.
        const branches = await tx
          .select({ id: chronoBranch.id, name: chronoBranch.name, code: chronoBranch.code })
          .from(chronoBranch)
          .where(eq(chronoBranch.status, "active"))
          .orderBy(asc(chronoBranch.name));

        // We read all stations for the public aggregate view. (Pagination left out as this is an aggregate + full grid).
        const stations = await tx
          .select()
          .from(chronoStation)
          .orderBy(asc(chronoStation.stationNumber));

        // Buckets reconcile: total === available + inUse + unavailable.
        // `inUse` counts stations with a live session ("occupied"), which is
        // what the web has always labelled it ("In session"). It previously
        // counted maintenance+offline instead, so a machine under maintenance
        // was advertised as in use and an actually-occupied one was counted
        // nowhere. Counting goes through the same normaliser the station list
        // uses, so the buckets can never disagree with the rows.
        const toAggregate = (rows: typeof stations) => {
          const normalised = rows.map((s) => toPublicStationStatus(s.status));
          const count = (v: ChronoStationStatus) =>
            normalised.filter((s) => s === v).length;
          const occupied = count("occupied");
          return {
            total: normalised.length,
            available: count("available"),
            inUse: occupied,
            occupied,
            unavailable: count("maintenance") + count("offline"),
          };
        };

        const branchesWithStations = branches.map((branch) => {
          const branchStations = stations.filter((s) => s.branchId === branch.id);
          return {
            id: branch.id,
            name: branch.name,
            code: branch.code,
            aggregate: toAggregate(branchStations),
            stations: branchStations.map((s) => ({
              id: s.id,
              name: s.name,
              stationNumber: s.stationNumber,
              stationType: s.stationType,
              // `status` is a free-text column, so it is parsed rather than
              // cast (the same discipline as publishStationTransition above).
              // An unrecognised value degrades to "offline": never advertise a
              // station as playable on a value we cannot interpret.
              status: toPublicStationStatus(s.status),
            })),
          };
        });

        // Top-level aggregate reflects only stations under visible (active) branches —
        // must match what the grouped view below actually shows.
        const visibleStations = stations.filter((s) =>
          branches.some((b) => b.id === s.branchId),
        );

        return {
          aggregate: toAggregate(visibleStations),
          branches: branchesWithStations,
        };
      });

      // Update cache
      publicStationsCache.set(tenantId, { data, at: now });

      return c.json(data);
    });
}

export function stationRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    // GET /stations/board — the Station Control board's aggregate read: every
    // station for one branch, with its group name and current active/paused
    // session already joined in. Deliberately unpaginated (bounded to one
    // branch), mirroring `publicStationRoutes()`'s own "read everything for
    // this branch" precedent. Ungated beyond tenant membership, matching
    // `GET /stations` / `GET /stations/groups` — staff need this to work the
    // floor. See `.ai/plans/chrono/active/station-control-grouping/README.md`,
    // Phase 1.
    .get(
      "/stations/board",
      zValidator("query", stationBoardQuerySchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { branchId } = c.req.valid("query");

        const rows = await withTenant(tenantId, (tx) =>
          tx
            .select({
              id: chronoStation.id,
              stationNumber: chronoStation.stationNumber,
              name: chronoStation.name,
              stationType: chronoStation.stationType,
              status: chronoStation.status,
              locationZone: chronoStation.locationZone,
              stationGroupId: chronoStation.stationGroupId,
              stationGroupName: chronoStationGroup.name,
              sessionId: chronoSession.id,
              sessionMemberId: chronoSession.memberId,
              sessionMemberName: base.tenantMember.name,
              sessionStatus: chronoSession.status,
              sessionStartedAt: chronoSession.startedAt,
              sessionScheduledEndAt: chronoSession.scheduledEndAt,
              sessionPausedAt: chronoSession.pausedAt,
            })
            .from(chronoStation)
            .leftJoin(
              chronoStationGroup,
              eq(chronoStation.stationGroupId, chronoStationGroup.id),
            )
            .leftJoin(
              chronoSession,
              and(
                eq(chronoSession.stationId, chronoStation.id),
                inArray(chronoSession.status, ["active", "paused"]),
              ),
            )
            .leftJoin(base.tenantMember, eq(chronoSession.memberId, base.tenantMember.id))
            .where(eq(chronoStation.branchId, branchId))
            .orderBy(asc(chronoStationGroup.name), asc(chronoStation.stationNumber)),
        );

        return c.json({
          branchId,
          stations: rows.map(toStationBoardDto),
        });
      },
    )

    // GET /stations — ungated (staff need this to work the floor).
    .get(
      "/stations",
      zValidator("query", stationListQuerySchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { page, pageSize, q, sort, order, branchId, stationGroupId } =
          c.req.valid("query");
        const conds = [];
        if (q) conds.push(ilike(chronoStation.name, `%${q}%`));
        if (branchId) conds.push(eq(chronoStation.branchId, branchId));
        if (stationGroupId) conds.push(eq(chronoStation.stationGroupId, stationGroupId));
        const where = conds.length ? and(...conds) : undefined;
        const sortCol =
          sort === "name"
            ? chronoStation.name
            : sort === "stationNumber"
              ? chronoStation.stationNumber
              : chronoStation.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoStation)
            .where(where);
          const rows = await tx
            .select(stationColumns)
            .from(chronoStation)
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows.map(toStationDto),
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    // GET /stations/groups — ungated.
    .get(
      "/stations/groups",
      zValidator("query", stationGroupListQuerySchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { page, pageSize, q, sort, order, branchId } = c.req.valid("query");
        const conds = [];
        if (q) conds.push(ilike(chronoStationGroup.name, `%${q}%`));
        if (branchId) conds.push(eq(chronoStationGroup.branchId, branchId));
        const where = conds.length ? and(...conds) : undefined;
        const sortCol =
          sort === "name"
            ? chronoStationGroup.name
            : sort === "code"
              ? chronoStationGroup.code
              : chronoStationGroup.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoStationGroup)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoStationGroup)
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows.map(toStationGroupDto),
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .post(
      "/stations/groups",
      zValidator("json", createStationGroupSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { station: ["create"] });
        const input = c.req.valid("json");

        let created;
        try {
          created = await withTenant(tenantId, async (tx) => {
            await requireOwnBranch(tx, tenantId, input.branchId);
            const [row] = await tx
              .insert(chronoStationGroup)
              .values({
                id: createId(),
                tenantId,
                branchId: input.branchId,
                name: input.name,
                code: input.code,
                description: input.description,
                hourlyRate: input.hourlyRate.toString(),
                memberRate: input.memberRate?.toString(),
              })
              .returning();
            return row;
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "A station group with that code already exists in this branch.");
          }
          throw err;
        }

        await recordStaffAudit(c, {
          action: "stationGroup.created",
          targetType: "stationGroup",
          targetId: created?.id,
          targetLabel: created?.name,
        });
        return c.json({ stationGroup: created ? toStationGroupDto(created) : null }, 201);
      },
    )

    .patch(
      "/stations/groups/:id",
      zValidator("json", updateStationGroupSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { station: ["update"] });
        const id = c.req.param("id");
        const input = c.req.valid("json");

        let updated;
        try {
          [updated] = await withTenant(tenantId, (tx) =>
            tx
              .update(chronoStationGroup)
              .set({
                ...(input.name !== undefined && { name: input.name }),
                ...(input.code !== undefined && { code: input.code }),
                ...(input.description !== undefined && { description: input.description }),
                ...(input.hourlyRate !== undefined && { hourlyRate: input.hourlyRate.toString() }),
                ...(input.memberRate !== undefined && { memberRate: input.memberRate.toString() }),
                updatedAt: new Date(),
              })
              .where(and(eq(chronoStationGroup.id, id), eq(chronoStationGroup.tenantId, tenantId)))
              .returning(),
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "A station group with that code already exists in this branch.");
          }
          throw err;
        }

        if (!updated) {
          throw new HttpError(404, "Station group not found.");
        }

        await recordStaffAudit(c, {
          action: "stationGroup.updated",
          targetType: "stationGroup",
          targetId: updated.id,
          targetLabel: updated.name,
        });
        return c.json({ stationGroup: toStationGroupDto(updated) });
      },
    )

    .delete("/stations/groups/:id", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["delete"] });
      const id = c.req.param("id");

      const deleted = await withTenant(tenantId, async (tx) => {
        const [inUse] = await tx
          .select({ id: chronoStation.id })
          .from(chronoStation)
          .where(eq(chronoStation.stationGroupId, id))
          .limit(1);
        if (inUse) {
          throw new HttpError(409, "This station group still has stations assigned to it.");
        }
        return tx
          .delete(chronoStationGroup)
          .where(and(eq(chronoStationGroup.id, id), eq(chronoStationGroup.tenantId, tenantId)))
          .returning();
      });

      if (deleted.length === 0) {
        throw new HttpError(404, "Station group not found.");
      }

      await recordStaffAudit(c, {
        action: "stationGroup.deleted",
        targetType: "stationGroup",
        targetId: id,
        targetLabel: deleted[0]?.name,
      });
      return c.json({ ok: true });
    })

    .post("/stations", zValidator("json", createStationSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["create"] });
      const input = c.req.valid("json");

      let created;
      try {
        created = await withTenant(tenantId, async (tx) => {
          await requireOwnBranch(tx, tenantId, input.branchId);
          if (input.stationGroupId) {
            await requireOwnGroupInBranch(tx, tenantId, input.branchId, input.stationGroupId);
          }
          const [row] = await tx
            .insert(chronoStation)
            .values({
              id: createId(),
              tenantId,
              branchId: input.branchId,
              stationGroupId: input.stationGroupId,
              name: input.name,
              stationNumber: input.stationNumber,
              stationType: input.stationType,
              status: input.status,
              locationZone: input.locationZone,
              specs: input.specs ?? null,
            })
            .returning();
          return row;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, "A station with that number already exists in this branch.");
        }
        throw err;
      }

      await recordStaffAudit(c, {
        action: "station.created",
        targetType: "station",
        targetId: created?.id,
        targetLabel: created?.name,
      });
      if (created) {
        await publishStationTransition(tenantId, created);
      }
      return c.json({ station: created ? toStationDto(created) : null }, 201);
    })

    .patch("/stations/:id", zValidator("json", updateStationSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["update"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      let updated;
      try {
        [updated] = await withTenant(tenantId, async (tx) => {
          if (input.stationGroupId !== undefined) {
            const [station] = await tx
              .select({ branchId: chronoStation.branchId })
              .from(chronoStation)
              .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
              .limit(1);
            if (!station) {
              throw new HttpError(404, "Station not found.");
            }
            await requireOwnGroupInBranch(tx, tenantId, station.branchId, input.stationGroupId);
          }
          return tx
            .update(chronoStation)
            .set({
              ...(input.stationGroupId !== undefined && { stationGroupId: input.stationGroupId }),
              ...(input.name !== undefined && { name: input.name }),
              ...(input.stationNumber !== undefined && { stationNumber: input.stationNumber }),
              ...(input.stationType !== undefined && { stationType: input.stationType }),
              ...(input.status !== undefined && { status: input.status }),
              ...(input.locationZone !== undefined && { locationZone: input.locationZone }),
              ...(input.specs !== undefined && { specs: input.specs }),
              updatedAt: new Date(),
            })
            .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
            .returning();
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, "A station with that number already exists in this branch.");
        }
        throw err;
      }

      if (!updated) {
        throw new HttpError(404, "Station not found.");
      }

      await recordStaffAudit(c, {
        action: "station.updated",
        targetType: "station",
        targetId: updated.id,
        targetLabel: updated.name,
      });
      await publishStationTransition(tenantId, updated);
      return c.json({ station: toStationDto(updated) });
    })

    .delete("/stations/:id", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["delete"] });
      const id = c.req.param("id");

      const deleted = await withTenant(tenantId, (tx) =>
        tx
          .delete(chronoStation)
          .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
          .returning(),
      );

      if (deleted.length === 0) {
        throw new HttpError(404, "Station not found.");
      }

      await recordStaffAudit(c, {
        action: "station.deleted",
        targetType: "station",
        targetId: id,
        targetLabel: deleted[0]?.name,
      });
      return c.json({ ok: true });
    });
}
