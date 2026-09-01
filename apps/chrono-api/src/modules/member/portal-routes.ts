import { Hono } from "hono";
import { withTenant, eq } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { createId } from "agora";
import { chronoMemberProfile } from "./schema";
import { applyForMembershipSchema } from "./contracts";

/**
 * Customer-facing venue-membership self-service surface — gated by the
 * foundation's `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission` (the caller is a customer, not
 * staff). Mounted directly on the Hono app at `/portal/members`, mirroring
 * how `/portal/auth` is mounted (apps/chrono-api/src/app.ts).
 */
export function memberPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/me", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoMemberProfile)
          .where(eq(chronoMemberProfile.memberId, memberId))
          .limit(1),
      );
      return c.json({ profile: row ?? null });
    })
    .post("/apply", zValidator("json", applyForMembershipSchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { phone } = c.req.valid("json");

      // Idempotent: an existing profile is returned unchanged — no duplicate
      // row, no re-triggered workflow (mirrors oikos's own idempotent-apply
      // behavior; see the module plan's "Failure cases" section).
      const existing = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoMemberProfile)
          .where(eq(chronoMemberProfile.memberId, memberId))
          .limit(1),
      );
      if (existing[0]) {
        return c.json({ profile: existing[0] });
      }

      const [created] = await withTenant(tenantId, (tx) =>
        tx
          .insert(chronoMemberProfile)
          .values({
            id: createId(),
            tenantId,
            memberId,
            phone: phone ?? null,
            applicationStatus: "pending",
          })
          .returning(),
      );

      // Customer-initiated action — unaudited in this pass (recordStaffAudit
      // is staff-actor-shaped; see the module plan's Routes section).
      return c.json({ profile: created }, 201);
    });
}
