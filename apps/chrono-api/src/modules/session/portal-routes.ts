import { Hono } from "hono";
import { withTenant, eq, and, inArray, desc } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { chronoStation } from "../station/schema";
import { chronoSession } from "./schema";

/**
 * Customer-facing session self-service surface — gated by the foundation's
 * `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/sessions`, mirroring how `/portal/wallet` is mounted
 * (apps/chrono-api/src/app.ts).
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
    });
}
