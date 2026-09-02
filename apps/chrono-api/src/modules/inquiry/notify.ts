import { withTenant, eq, adminDb, schema as baseSchema } from "agora/db";
import { permissionsForRole, permissionsForCustomRole } from "agora/auth";
import { createId } from "agora";
import { tenantNotification } from "../../db/schema";
import { logger } from "agora/server";
import { hasPermission } from "../../auth/require-permission";

/**
 * Every staff member of `tenantId` who currently holds `inquiry:manage` —
 * system roles resolve via `permissionsForRole`, tenant-defined custom roles
 * via their stored `OrganizationRoles` grant map (sanitized against the live
 * vocabulary). Used only for the new-inquiry notification fan-out (Open
 * Question 3's "all holders" default) — never a security boundary.
 */
export async function resolveInquiryManageRecipients(tenantId: string): Promise<string[]> {
  const members = await adminDb
    .select({ userId: baseSchema.member.userId, role: baseSchema.member.role })
    .from(baseSchema.member)
    .where(eq(baseSchema.member.organizationId, tenantId));
  if (members.length === 0) return [];

  const customRoleKeys = [...new Set(members.map((m) => m.role))].filter(
    (role) => role !== "staff" && role !== "admin" && role !== "owner",
  );
  const customGrants = new Map<string, Record<string, string[]>>();
  if (customRoleKeys.length > 0) {
    const rows = await adminDb
      .select({ role: baseSchema.organizationRole.role, permission: baseSchema.organizationRole.permission })
      .from(baseSchema.organizationRole)
      .where(eq(baseSchema.organizationRole.organizationId, tenantId));
    for (const row of rows) customGrants.set(row.role, row.permission);
  }

  const recipients: string[] = [];
  for (const m of members) {
    const perms =
      m.role === "staff" || m.role === "admin" || m.role === "owner"
        ? permissionsForRole(m.role)
        : permissionsForCustomRole(customGrants.get(m.role));
    if (hasPermission(perms, { inquiry: ["manage"] })) recipients.push(m.userId);
  }
  return recipients;
}

/**
 * Fan out a dashboard bell notification to every staff member holding
 * `inquiry:manage` when a new inquiry is submitted (customer- or
 * anonymous-submitted) — best-effort, never blocks the submission itself.
 */
export async function notifyInquiryManagers(
  tenantId: string,
  inquiryId: string,
  subject: string,
): Promise<void> {
  try {
    const recipients = await resolveInquiryManageRecipients(tenantId);
    if (recipients.length === 0) return;
    await withTenant(tenantId, (tx) =>
      tx.insert(tenantNotification).values(
        recipients.map((recipientUserId) => ({
          id: createId(),
          tenantId,
          recipientUserId,
          type: "inquiry_created",
          title: `New inquiry: ${subject}`,
          body: null,
          href: `/dashboard/inquiries/${inquiryId}`,
          actorUserId: null,
          actorName: null,
        })),
      ),
    );
  } catch (err) {
    logger.warn({ err, msg: "Failed to record inquiry_created notification" });
  }
}
