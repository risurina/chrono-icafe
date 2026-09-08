import type { Context } from "hono";
import { withTenant, eq } from "agora/db";
import { HttpError } from "agora/server";
import type { MemberVars } from "agora/member-auth";
import { chronoMemberProfile } from "./schema";

/**
 * Mutation gate for the member portal — call at the top of every mutating
 * `/portal/*` handler (after `memberMiddleware()`/`requireMemberActionHeader`/
 * any rate limiter, before any DB work), EXCEPT `POST /portal/members/apply`
 * itself, which a `"visitor"` must remain able to call — that's the only path
 * that promotes a visitor into a real applicant
 * (`.ai/plans/chrono/in-progress/member-visitor-status-tier/README.md`).
 *
 * A caller with no `chronoMemberProfile` row yet, or a row whose
 * `applicationStatus` is anything other than `"pending"`/`"approved"` (i.e.
 * `"visitor"` or `"rejected"`), gets a 403 — same `HttpError` convention this
 * app already uses everywhere else (see `modules/branch/routes.ts`), not the
 * foundation's tenant-permission `ForbiddenError` (that vocabulary is for
 * staff `requirePermission`, not this member-status gate).
 */
export async function requireAppliedMembership(c: Context<{ Variables: MemberVars }>) {
  const { tenantId, memberId } = c.var.member;
  const [profile] = await withTenant(tenantId, (tx) =>
    tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(eq(chronoMemberProfile.memberId, memberId))
      .limit(1),
  );
  const status = profile?.applicationStatus;
  if (status !== "pending" && status !== "approved") {
    throw new HttpError(403, "Apply for membership before doing this.");
  }
}
