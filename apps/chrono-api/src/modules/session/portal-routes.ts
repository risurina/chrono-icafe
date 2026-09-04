import { Hono } from "hono";
import { withTenant, eq, and, inArray, desc, count } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { buildPaginationMeta } from "agora";
import { chronoStation } from "../station/schema";
import { chronoBranch } from "../branch/schema";
import { chronoSession } from "./schema";
import { portalSessionListQuerySchema } from "./contracts";
import { summarizeTodayUsage } from "./usage";

function toPortalSessionSummary(row: {
  id: string;
  stationId: string;
  stationName: string;
  status: string;
  startedAt: Date;
  scheduledEndAt: Date | null;
  endedAt: Date | null;
  actualBillableSeconds: number | null;
  amountCharged: string | null;
  currency: string;
}) {
  return {
    id: row.id,
    stationId: row.stationId,
    stationName: row.stationName,
    status: row.status as "active" | "paused" | "ended",
    startedAt: row.startedAt.toISOString(),
    scheduledEndAt: row.scheduledEndAt ? row.scheduledEndAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    actualBillableSeconds: row.actualBillableSeconds,
    amountCharged: row.amountCharged,
    currency: row.currency,
  };
}

/**
 * Customer-facing session self-service surface — gated by the foundation's
 * `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/sessions`, mirroring how `/portal/wallet` is mounted.
 *
 * Route order matters: `/active` and `/summary` are registered BEFORE
 * `/:id` so those literal paths are never swallowed by the `:id` param.
 */
export function sessionPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/active", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select({
            id: chronoSession.id,
            stationId: chronoSession.stationId,
            stationName: chronoStation.name,
            status: chronoSession.status,
            startedAt: chronoSession.startedAt,
            scheduledEndAt: chronoSession.scheduledEndAt,
          })
          .from(chronoSession)
          .innerJoin(chronoStation, eq(chronoSession.stationId, chronoStation.id))
          .where(
            and(
              eq(chronoSession.memberId, memberId),
              inArray(chronoSession.status, ["active", "paused"]),
            ),
          )
          .orderBy(desc(chronoSession.startedAt))
          .limit(1),
      );
      // No auto-create, no cost-so-far figure — "no active session" is a
      // normal state, not an error, and an estimate is never billing truth.
      return c.json({ session: row ?? null });
    })
    // Today's usage — computed from ENDED sessions only, never estimating
    // the still-running one server-side (usage.ts's own doc comment).
    .get("/summary", async (c) => {
      const { tenantId, memberId } = c.var.member;

      const { active, ended, timezone } = await withTenant(tenantId, async (tx) => {
        const [activeRow] = await tx
          .select({
            id: chronoSession.id,
            stationId: chronoSession.stationId,
            stationName: chronoStation.name,
            status: chronoSession.status,
            startedAt: chronoSession.startedAt,
            scheduledEndAt: chronoSession.scheduledEndAt,
          })
          .from(chronoSession)
          .innerJoin(chronoStation, eq(chronoSession.stationId, chronoStation.id))
          .where(
            and(
              eq(chronoSession.memberId, memberId),
              inArray(chronoSession.status, ["active", "paused"]),
            ),
          )
          .orderBy(desc(chronoSession.startedAt))
          .limit(1);

        // Branch timezone: derived from the active session's branch when one
        // exists, else the member's most recent session's branch, else the
        // tenant default (Asia/Manila, matching branch/schema.ts's own
        // column default) — a member with zero sessions has no branch to
        // resolve from at all.
        const [recentBranch] = await tx
          .select({ timezone: chronoBranch.timezone })
          .from(chronoSession)
          .innerJoin(chronoBranch, eq(chronoSession.branchId, chronoBranch.id))
          .where(eq(chronoSession.memberId, memberId))
          .orderBy(desc(chronoSession.startedAt))
          .limit(1);

        const endedRows = await tx
          .select({
            startedAt: chronoSession.startedAt,
            actualBillableSeconds: chronoSession.actualBillableSeconds,
            amountCharged: chronoSession.amountCharged,
            currency: chronoSession.currency,
          })
          .from(chronoSession)
          .where(and(eq(chronoSession.memberId, memberId), eq(chronoSession.status, "ended")));

        return {
          active: activeRow ?? null,
          ended: endedRows,
          timezone: recentBranch?.timezone ?? "Asia/Manila",
        };
      });

      return c.json({
        active: active ? toPortalSessionSummary({ ...active, endedAt: null, actualBillableSeconds: null, amountCharged: null, currency: "PHP" }) : null,
        today: summarizeTodayUsage(ended, timezone),
      });
    })
    .get("/", zValidator("query", portalSessionListQuerySchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { page, pageSize } = c.req.valid("query");

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx
          .select({ value: count() })
          .from(chronoSession)
          .where(eq(chronoSession.memberId, memberId));
        const rows = await tx
          .select({
            id: chronoSession.id,
            stationId: chronoSession.stationId,
            stationName: chronoStation.name,
            status: chronoSession.status,
            startedAt: chronoSession.startedAt,
            scheduledEndAt: chronoSession.scheduledEndAt,
            endedAt: chronoSession.endedAt,
            actualBillableSeconds: chronoSession.actualBillableSeconds,
            amountCharged: chronoSession.amountCharged,
            currency: chronoSession.currency,
          })
          .from(chronoSession)
          .innerJoin(chronoStation, eq(chronoSession.stationId, chronoStation.id))
          .where(eq(chronoSession.memberId, memberId))
          .orderBy(desc(chronoSession.startedAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });

      return c.json({
        items: rows.map(toPortalSessionSummary),
        meta: buildPaginationMeta(page, pageSize, totalItems, "startedAt", "desc"),
      });
    })
    // 404s on another member's or another tenant's session — no existence
    // leak (withTenant's RLS scope handles the cross-tenant half; the
    // explicit memberId filter handles the cross-member half).
    .get("/:id", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const id = c.req.param("id");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select({
            id: chronoSession.id,
            stationId: chronoSession.stationId,
            stationName: chronoStation.name,
            status: chronoSession.status,
            startedAt: chronoSession.startedAt,
            scheduledEndAt: chronoSession.scheduledEndAt,
            endedAt: chronoSession.endedAt,
            actualBillableSeconds: chronoSession.actualBillableSeconds,
            amountCharged: chronoSession.amountCharged,
            currency: chronoSession.currency,
            rateSnapshot: chronoSession.rateSnapshot,
            creditMinutesConsumed: chronoSession.creditMinutesConsumed,
          })
          .from(chronoSession)
          .innerJoin(chronoStation, eq(chronoSession.stationId, chronoStation.id))
          .where(and(eq(chronoSession.id, id), eq(chronoSession.memberId, memberId)))
          .limit(1),
      );

      if (!row) {
        return c.json({ error: "Session not found" }, 404);
      }

      return c.json({
        session: {
          ...toPortalSessionSummary(row),
          rateSnapshot: row.rateSnapshot,
          creditMinutesConsumed: row.creditMinutesConsumed,
        },
      });
    });
}
