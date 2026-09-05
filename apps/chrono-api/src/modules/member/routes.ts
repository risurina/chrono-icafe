import { Hono } from "hono";
import { withTenant, adminDb, schema as base, eq, count, asc, desc } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import {
  type TenantVars,
  HttpError,
  zValidator,
  renderBrandedEmail,
  sendTransactionalEmail,
  escapeHtml,
} from "agora/server";
import { listQuerySchema, createId, type PaginationMeta } from "agora";
import { recordStaffAudit } from "agora/audit";
import { inviteTenantMember } from "agora/member-auth";
import { chronoMemberProfile } from "./schema";
import { inviteMemberSchema, updateMemberProfileSchema, toMemberProfile } from "./contracts";
import { approveMemberProfile, rejectMemberProfile } from "./service";

/**
 * Sends one branded email to a `tenantMember` (a customer, never a Better
 * Auth `user`). Mirrors `agora/member-auth`'s own private `sendMemberEmail`
 * helper exactly (read tenantBranding → renderBrandedEmail → sendTransactionalEmail)
 * rather than importing it — that helper is unexported and member-auth is a
 * foundation module Chrono must not fork. See
 * .ai/plans/chrono/active/customer-onboarding/README.md, "Notifications":
 * the foundation's `notificationTemplate` registry is platform-staff-only
 * with no extension seam, so this bypasses it by design — no admin-editable
 * override for these two transactional emails in this pass.
 */
async function sendMemberOnboardingEmail(
  tenantId: string,
  to: string,
  subject: string,
  bodyHtml: string,
): Promise<void> {
  const [b] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        displayName: base.tenantBranding.displayName,
        emailFromName: base.tenantBranding.emailFromName,
        emailReplyTo: base.tenantBranding.emailReplyTo,
        emailLogoUrl: base.tenantBranding.emailLogoUrl,
        primaryColor: base.tenantBranding.primaryColor,
        supportEmail: base.tenantBranding.supportEmail,
      })
      .from(base.tenantBranding)
      .where(eq(base.tenantBranding.tenantId, tenantId))
      .limit(1),
  );
  const email = renderBrandedEmail(
    {
      displayName: b?.displayName ?? null,
      emailFromName: b?.emailFromName ?? null,
      emailReplyTo: b?.emailReplyTo ?? null,
      emailLogoUrl: b?.emailLogoUrl ?? null,
      primaryColor: b?.primaryColor ?? null,
      supportEmail: b?.supportEmail ?? null,
    },
    { subject, bodyHtml },
  );
  await sendTransactionalEmail({ ...email, to }, { tenantId });
}

/** Generic copy — no rejection-reason placeholder (the schema has no reason
 * column in this pass; see the plan's Out of Scope). */
const APPROVED_EMAIL_SUBJECT = "You're approved — welcome to {{tenantName}}";
const APPROVED_EMAIL_BODY = `<p>Good news — your application to <strong>{{tenantName}}</strong> has been approved.</p>
  <p>You can now sign in to the member portal and get started.</p>`;
const REJECTED_EMAIL_SUBJECT = "An update on your application to {{tenantName}}";
const REJECTED_EMAIL_BODY = `<p>Your application to <strong>{{tenantName}}</strong> was not approved at this time.</p>
  <p>If you have questions, please contact the business directly.</p>`;

function fillTemplate(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(values)) {
    out = out.split(`{{${token}}}`).join(escapeHtml(value));
  }
  return out;
}

/**
 * Best-effort — a send failure must never fail the approve/reject request
 * itself (the status transition already committed). Resolves the member's
 * email via `withTenant` (RLS-scoped, `tenantMember` is tenant-owned data)
 * and the tenant's display name via `adminDb` (`organization` is a
 * foundation table filtered explicitly by id, same as
 * `apps/chrono-api/src/routes/rpc.ts`'s own `resolveTenantPathSegment`).
 */
async function notifyMemberOfDecision(
  tenantId: string,
  memberId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  try {
    const [member] = await withTenant(tenantId, (tx) =>
      tx
        .select({ email: base.tenantMember.email, name: base.tenantMember.name })
        .from(base.tenantMember)
        .where(eq(base.tenantMember.id, memberId))
        .limit(1),
    );
    if (!member) return;

    const [org] = await adminDb
      .select({ name: base.organization.name })
      .from(base.organization)
      .where(eq(base.organization.id, tenantId))
      .limit(1);
    const tenantName = org?.name ?? "the business";

    const [subject, body] =
      decision === "approved"
        ? [APPROVED_EMAIL_SUBJECT, APPROVED_EMAIL_BODY]
        : [REJECTED_EMAIL_SUBJECT, REJECTED_EMAIL_BODY];

    await sendMemberOnboardingEmail(
      tenantId,
      member.email,
      fillTemplate(subject, { tenantName }),
      fillTemplate(body, { tenantName }),
    );
  } catch {
    // Notification is best-effort; the transition itself already succeeded.
  }
}

/** Shared `{page, pageSize, ...}` → `PaginationMeta` builder, mirroring
 * apps/chrono-api/src/routes/rpc.ts's own helper — duplicated locally (not
 * imported from there) to avoid a circular import, since rpc.ts composes
 * this module's routes via `.route("/members", memberProfileRoutes())`. */
function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
): PaginationMeta {
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

/** Wire shape for a staff-facing member row — every `tenantMember` belonging
 * to the tenant, left-joined against its `chronoMemberProfile` (which may not
 * exist: a global-customer "apply" or a directly-created `/rpc/customers` row
 * has none). `profileId`/`applicationStatus`/`appliedAt`/`approvedAt`/
 * `rejectedAt`/`phone` are null exactly when there is no profile row — never
 * the raw Drizzle join result. */
type MemberProfileListItem = {
  memberId: string;
  profileId: string | null;
  tenantId: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  phone: string | null;
  applicationStatus: string | null;
  appliedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
};

/**
 * Staff-facing venue-membership workflow — a Chrono-owned extension of the
 * foundation's `customer` (tenant_member) identity, gated on Chrono's own
 * `memberProfile` permission resource (this is a read/update over the same
 * underlying rows the `/rpc/customers` routes already manage — see
 * .ai/plans/chrono/active/audit-remediation/README.md, Phase 5). Composed into
 * apps/chrono-api/src/routes/rpc.ts via `.route("/members", memberProfileRoutes())`.
 */
export function memberProfileRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // customer-onboarding Phase 2: staff badge — how many applications are
    // waiting, so approvals stop stalling. Scoped to c.var.tenant.tenantId
    // via withTenant; gated on the same memberProfile:read the list route
    // already uses (this is a read, not a new capability).
    .get("/pending-count", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { memberProfile: ["read"] });
      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select({ value: count() })
          .from(chronoMemberProfile)
          .where(eq(chronoMemberProfile.applicationStatus, "pending")),
      );
      return c.json({ pendingCount: row?.value ?? 0 });
    })
    .get(
      "/",
      zValidator("query", listQuerySchema(["appliedAt", "createdAt"])),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { memberProfile: ["read"] });
        const { page, pageSize, sort, order } = c.req.valid("query");
        // Sort by the profile column when one was requested — a null
        // `appliedAt` (no profile row) sorts last in Postgres regardless of
        // direction, which is an acceptable, non-crashing default; the list
        // is still always ordered by `tenantMember.createdAt` as the
        // fallback default (no profile-less bias for the common case).
        const sortCol =
          sort === "appliedAt" ? chronoMemberProfile.appliedAt : base.tenantMember.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        // LEFT JOIN, not inner: every tenantMember belonging to this tenant
        // must appear, including one with no chronoMemberProfile row (a
        // global-customer "apply" or a directly-created /rpc/customers row —
        // see .ai/plans/chrono/active/customers-members-merge/README.md).
        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(base.tenantMember)
            .leftJoin(
              chronoMemberProfile,
              eq(chronoMemberProfile.memberId, base.tenantMember.id),
            );
          const rows = await tx
            .select({
              memberId: base.tenantMember.id,
              profileId: chronoMemberProfile.id,
              tenantId: base.tenantMember.tenantId,
              name: base.tenantMember.name,
              email: base.tenantMember.email,
              status: base.tenantMember.status,
              phone: chronoMemberProfile.phone,
              applicationStatus: chronoMemberProfile.applicationStatus,
              appliedAt: chronoMemberProfile.appliedAt,
              approvedAt: chronoMemberProfile.approvedAt,
              rejectedAt: chronoMemberProfile.rejectedAt,
              createdAt: chronoMemberProfile.createdAt,
              memberCreatedAt: base.tenantMember.createdAt,
            })
            .from(base.tenantMember)
            .leftJoin(
              chronoMemberProfile,
              eq(chronoMemberProfile.memberId, base.tenantMember.id),
            )
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        const items: MemberProfileListItem[] = rows.map((r) => ({
          memberId: r.memberId,
          profileId: r.profileId,
          tenantId: r.tenantId,
          name: r.name,
          email: r.email,
          status: r.status as "active" | "suspended",
          phone: r.phone,
          applicationStatus: r.applicationStatus,
          appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
          approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
          rejectedAt: r.rejectedAt ? r.rejectedAt.toISOString() : null,
          createdAt: (r.createdAt ?? r.memberCreatedAt).toISOString(),
        }));

        return c.json({
          items,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )
    .patch(
      "/:memberId",
      zValidator("json", updateMemberProfileSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { memberProfile: ["update"] });
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const [row] = await withTenant(tenantId, (tx) =>
          tx
            .update(chronoMemberProfile)
            .set({
              ...(input.phone !== undefined ? { phone: input.phone } : {}),
              updatedAt: new Date(),
            })
            .where(eq(chronoMemberProfile.memberId, memberId))
            .returning(),
        );
        if (!row) throw new HttpError(404, "Member profile not found.");

        await recordStaffAudit(c, {
          action: "chronoMemberProfile.updated",
          targetType: "chronoMemberProfile",
          targetId: row.id,
          targetLabel: row.memberId,
        });
        return c.json({ profile: toMemberProfile(row) });
      },
    )
    .post("/:memberId/approve", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { memberProfile: ["approve"] });
      const memberId = c.req.param("memberId");

      // approveMemberProfile throws 409 on a no-op re-approval — so reaching
      // here always means a genuine transition (customer-onboarding Phase 1,
      // Decision 4: emit the notification only on a real transition).
      const { row, previousStatus } = await withTenant(tenantId, (tx) =>
        approveMemberProfile(tx, { tenantId, memberId })
      );

      await recordStaffAudit(c, {
        action: "chronoMemberProfile.approved",
        targetType: "chronoMemberProfile",
        targetId: row.id,
        targetLabel: row.memberId,
        metadata: { from: previousStatus, to: "approved" },
      });
      await notifyMemberOfDecision(tenantId, memberId, "approved");
      return c.json({ profile: toMemberProfile(row) });
    })
    .post("/:memberId/reject", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { memberProfile: ["reject"] });
      const memberId = c.req.param("memberId");

      const { row, previousStatus } = await withTenant(tenantId, (tx) =>
        rejectMemberProfile(tx, { tenantId, memberId })
      );

      await recordStaffAudit(c, {
        action: "chronoMemberProfile.rejected",
        targetType: "chronoMemberProfile",
        targetId: row.id,
        targetLabel: row.memberId,
        metadata: { from: previousStatus, to: "rejected" },
      });
      await notifyMemberOfDecision(tenantId, memberId, "rejected");
      return c.json({ profile: toMemberProfile(row) });
    })
    // customer-invite: staff proactively brings a customer in — mints a
    // tenantMember invite (agora/member-auth's `inviteTenantMember`, which
    // creates the tenantMember row on first invite) and approves the
    // ChronoMemberProfiles row immediately, since an invite is itself the
    // approval decision (no separate approve step). See
    // .ai/plans/chrono/active/customer-invite/README.md.
    .post("/invite", zValidator("json", inviteMemberSchema), async (c) => {
      const { tenantId, tenantSlug } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { memberProfile: ["invite"] });
      const { email, name } = c.req.valid("json");

      const { member, resent } = await inviteTenantMember({
        tenantId,
        tenantSlug,
        email,
        name,
      });

      const now = new Date();
      await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoMemberProfile.id })
          .from(chronoMemberProfile)
          .where(eq(chronoMemberProfile.memberId, member.id))
          .limit(1);
        if (existing) return;
        await tx.insert(chronoMemberProfile).values({
          id: createId(),
          tenantId,
          memberId: member.id,
          applicationStatus: "approved",
          appliedAt: now,
          approvedAt: now,
        });
      });

      await recordStaffAudit(c, {
        action: "chronoMemberProfile.invited",
        targetType: "tenantMember",
        targetId: member.id,
        targetLabel: member.email,
        metadata: { resent },
      });

      return c.json({ memberId: member.id, email: member.email, name: member.name, resent }, 201);
    });
}
