import { Hono } from "hono";
import { withTenant, eq, and, inArray, desc } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { createId } from "agora";
import { chronoMemberProfile } from "./schema";
import { applyForMembershipSchema, updateMyMemberProfileSchema, toMemberProfile } from "./contracts";
import { requireAppliedMembership } from "./access";
import { getChronoTenantFlag } from "../../contracts/extensions";
import { chronoWallet } from "../wallet/schema";
import { chronoReservation } from "../reservation/schema";
import { chronoSession } from "../session/schema";
import { chronoBranch } from "../branch/schema";

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
    // member-profile-security-and-avatar Phase 1: the branch of the member's
    // most recent PHYSICAL visit — a checked-in/completed reservation or any
    // session row (never a mere pending/hold/confirmed booking). `null` when
    // the member has no qualifying activity yet (must not error).
    .get("/me/recent-branch", async (c) => {
      const { tenantId, memberId } = c.var.member;

      const [lastReservation, lastSession] = await withTenant(tenantId, (tx) =>
        Promise.all([
          tx
            .select({
              branchId: chronoBranch.id,
              branchName: chronoBranch.name,
              visitedAt: chronoReservation.checkedInAt,
            })
            .from(chronoReservation)
            .innerJoin(chronoBranch, eq(chronoReservation.branchId, chronoBranch.id))
            .where(
              and(
                eq(chronoReservation.memberId, memberId),
                inArray(chronoReservation.status, ["checked_in", "completed"]),
              ),
            )
            .orderBy(desc(chronoReservation.checkedInAt))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          tx
            .select({
              branchId: chronoBranch.id,
              branchName: chronoBranch.name,
              visitedAt: chronoSession.startedAt,
            })
            .from(chronoSession)
            .innerJoin(chronoBranch, eq(chronoSession.branchId, chronoBranch.id))
            .where(eq(chronoSession.memberId, memberId))
            .orderBy(desc(chronoSession.startedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        ]),
      );

      const candidates = [lastReservation, lastSession].filter(
        (row): row is NonNullable<typeof row> => row !== null && row.visitedAt !== null,
      );
      if (candidates.length === 0) {
        return c.json({ recentBranch: null });
      }
      const latest = candidates.reduce((a, b) =>
        (a.visitedAt as Date) > (b.visitedAt as Date) ? a : b,
      );

      return c.json({
        recentBranch: {
          branchId: latest.branchId,
          branchName: latest.branchName,
          lastActivityAt: (latest.visitedAt as Date).toISOString(),
        },
      });
    })
    .post("/apply", zValidator("json", applyForMembershipSchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { phone } = c.req.valid("json");

      // Idempotent: an existing "pending"/"approved"/"rejected" profile is
      // returned unchanged — no duplicate row, no re-triggered workflow
      // (mirrors oikos's own idempotent-apply behavior; see the module
      // plan's "Failure cases" section). A "visitor" row is the one
      // exception — see below, this is the call that promotes it.
      const existing = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoMemberProfile)
          .where(eq(chronoMemberProfile.memberId, memberId))
          .limit(1),
      );

      // customer-onboarding Phase 1, Decision 1: a tenant may opt into instant
      // access via the `chrono.autoApproveMembers` flag (default off — most
      // venues want to vet a walk-in before granting access).
      const autoApprove = await getChronoTenantFlag(tenantId, "chrono.autoApproveMembers");
      const now = new Date();

      if (existing[0]) {
        // member-visitor-status-tier: a "visitor" row (auto-created on first
        // visit, see `/visit` below) is not yet an application — promote it
        // in place instead of returning it unchanged. Every other existing
        // status keeps today's untouched-return behavior exactly.
        if (existing[0].applicationStatus === "visitor") {
          const [promoted] = await withTenant(tenantId, (tx) =>
            tx
              .update(chronoMemberProfile)
              .set({
                phone: phone ?? existing[0]!.phone,
                applicationStatus: autoApprove ? "approved" : "pending",
                ...(autoApprove ? { approvedAt: now } : {}),
                updatedAt: now,
              })
              .where(eq(chronoMemberProfile.memberId, memberId))
              .returning(),
          );
          return c.json({ profile: promoted ? toMemberProfile(promoted) : null });
        }
        return c.json({ profile: toMemberProfile(existing[0]) });
      }

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
    })
    // member-visitor-status-tier Phase 1: silent first-visit registration —
    // NOT gated by `requireAppliedMembership` (a "visitor" must be able to
    // call this; it's what creates the "visitor" row in the first place).
    // Idempotent: an existing row of ANY status is returned unchanged, same
    // response shape as `/apply`'s own existing-row branch.
    .post("/visit", async (c) => {
      const { tenantId, memberId } = c.var.member;

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

      const [created] = await withTenant(tenantId, (tx) =>
        tx
          .insert(chronoMemberProfile)
          .values({
            id: createId(),
            tenantId,
            memberId,
            applicationStatus: "visitor",
          })
          .returning(),
      );

      return c.json({ profile: created ? toMemberProfile(created) : null }, 201);
    })
    // Member-portal self-update (Phase F2) — 404 before the member has ever
    // applied (no chronoMemberProfile row yet); apply first, then edit.
    .patch("/me", zValidator("json", updateMyMemberProfileSchema), async (c) => {
      await requireAppliedMembership(c);
      const { tenantId, memberId } = c.var.member;
      const { phone } = c.req.valid("json");

      const [updated] = await withTenant(tenantId, (tx) =>
        tx
          .update(chronoMemberProfile)
          .set({ phone: phone ?? null, updatedAt: new Date() })
          .where(eq(chronoMemberProfile.memberId, memberId))
          .returning(),
      );
      if (!updated) {
        return c.json({ error: "Apply for membership before editing your profile" }, 404);
      }
      return c.json({ profile: toMemberProfile(updated) });
    });
}
