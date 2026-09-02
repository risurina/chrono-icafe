import { eq, and, not } from "agora/db";
import type { TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoMemberProfile } from "./schema";

export type ChronoMemberProfileRow = typeof chronoMemberProfile.$inferSelect;

export async function approveMemberProfile(
  tx: TenantTx,
  args: { tenantId: string; memberId: string },
): Promise<{ row: ChronoMemberProfileRow; previousStatus: string }> {
  const [pre] = await tx
    .select({ applicationStatus: chronoMemberProfile.applicationStatus })
    .from(chronoMemberProfile)
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
      ),
    )
    .limit(1);

  const [row] = await tx
    .update(chronoMemberProfile)
    .set({
      applicationStatus: "approved",
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
        not(eq(chronoMemberProfile.applicationStatus, "approved")),
      ),
    )
    .returning();

  if (!row) {
    const [current] = await tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(
        and(
          eq(chronoMemberProfile.tenantId, args.tenantId),
          eq(chronoMemberProfile.memberId, args.memberId),
        ),
      )
      .limit(1);

    if (!current) {
      throw new HttpError(404, "Member profile not found.");
    }
    throw new HttpError(
      409,
      "This application has already been approved.",
    );
  }

  return { row, previousStatus: pre?.applicationStatus ?? "pending" };
}

export async function rejectMemberProfile(
  tx: TenantTx,
  args: { tenantId: string; memberId: string },
): Promise<{ row: ChronoMemberProfileRow; previousStatus: string }> {
  const [pre] = await tx
    .select({ applicationStatus: chronoMemberProfile.applicationStatus })
    .from(chronoMemberProfile)
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
      ),
    )
    .limit(1);

  const [row] = await tx
    .update(chronoMemberProfile)
    .set({
      applicationStatus: "rejected",
      rejectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
        not(eq(chronoMemberProfile.applicationStatus, "rejected")),
      ),
    )
    .returning();

  if (!row) {
    const [current] = await tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(
        and(
          eq(chronoMemberProfile.tenantId, args.tenantId),
          eq(chronoMemberProfile.memberId, args.memberId),
        ),
      )
      .limit(1);

    if (!current) {
      throw new HttpError(404, "Member profile not found.");
    }
    throw new HttpError(
      409,
      "This application has already been rejected.",
    );
  }

  return { row, previousStatus: pre?.applicationStatus ?? "pending" };
}
