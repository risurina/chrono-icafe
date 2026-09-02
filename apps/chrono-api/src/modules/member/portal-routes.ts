import { Hono } from "hono";
import { withTenant, eq } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { createId } from "agora";
import { chronoMemberProfile } from "./schema";
import { applyForMembershipSchema, toMemberProfile } from "./contracts";
import { getChronoTenantFlag } from "../../contracts/extensions";
import { chronoWallet } from "../wallet/schema";

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
      return c.json({ profile: row ? toMemberProfile(row) : null });
    })
    // customer-onboarding Phase 2: the customer's own onboarding state — what
    // applicationStatus means, whether a wallet is provisioned yet, and
    // whether they currently qualify for member-rate pricing. Never another
    // member's or another tenant's data (memberMiddleware resolves both from
    // the session, exactly like `/me` above).
    .get("/me/onboarding", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const [profile, wallet] = await withTenant(tenantId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(chronoMemberProfile)
            .where(eq(chronoMemberProfile.memberId, memberId))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          tx
            .select({ balance: chronoWallet.balance, currency: chronoWallet.currency })
            .from(chronoWallet)
            .where(eq(chronoWallet.memberId, memberId))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        ]),
      );

      const applicationStatus = profile?.applicationStatus ?? "pending";
      return c.json({
        applicationStatus,
        appliedAt: profile?.appliedAt ? profile.appliedAt.toISOString() : null,
        approvedAt: profile?.approvedAt ? profile.approvedAt.toISOString() : null,
        rejectedAt: profile?.rejectedAt ? profile.rejectedAt.toISOString() : null,
        // `exists: false` (never a null check) drives the top-up prompt —
        // mirrors wallet/portal-routes.ts's own "no side-effecting
        // auto-create on a read" precedent.
        wallet: wallet
          ? { balance: wallet.balance, currency: wallet.currency, exists: true }
          : { balance: "0.00", currency: "PHP", exists: false },
        // Pricing only — applicationStatus carries no access enforcement
        // anywhere (member/schema.ts's own column comment); an approved
        // customer simply qualifies for a station group's memberRate where
        // one is configured. See session/service.ts's rate-resolution logic.
        memberRateEligible: applicationStatus === "approved",
      });
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
        return c.json({ profile: toMemberProfile(existing[0]) });
      }

      // customer-onboarding Phase 1, Decision 1: a tenant may opt into instant
      // access via the `chrono.autoApproveMembers` flag (default off — most
      // venues want to vet a walk-in before granting access).
      const autoApprove = await getChronoTenantFlag(tenantId, "chrono.autoApproveMembers");
      const now = new Date();

      const [created] = await withTenant(tenantId, (tx) =>
        tx
          .insert(chronoMemberProfile)
          .values({
            id: createId(),
            tenantId,
            memberId,
            phone: phone ?? null,
            applicationStatus: autoApprove ? "approved" : "pending",
            ...(autoApprove ? { approvedAt: now } : {}),
          })
          .returning(),
      );

      // Customer-initiated action — unaudited in this pass (recordStaffAudit
      // is staff-actor-shaped; see the module plan's Routes section).
      return c.json({ profile: created ? toMemberProfile(created) : null }, 201);
    });
}
