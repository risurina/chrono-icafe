import { z } from "zod";

export const memberApplicationStatusSchema = z.enum(["visitor", "pending", "approved", "rejected"]);

export const applyForMembershipSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

export const updateMemberProfileSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

// Member-portal self-update (Phase F2) — same shape as the staff-facing
// schema above, named separately so the portal route's own contract can
// evolve independently (e.g. gaining member-only fields later).
export const updateMyMemberProfileSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
});

export type MemberApplicationStatus = z.infer<typeof memberApplicationStatusSchema>;
export type ApplyForMembershipInput = z.infer<typeof applyForMembershipSchema>;
export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

// Response DTO for a `chronoMemberProfile` row — explicit column list, dates
// as ISO strings (.ai/rules/dto.md). Never the raw Drizzle `$inferSelect` row.
export const memberProfileDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  memberId: z.string(),
  phone: z.string().nullable(),
  memberCode: z.string().nullable(),
  applicationStatus: memberApplicationStatusSchema,
  appliedAt: z.string(),
  approvedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemberProfileDto = z.infer<typeof memberProfileDtoSchema>;

// Member-portal "recent branch" read (member-profile-security-and-avatar
// Phase 1) — the branch of the member's most recent physical visit (a
// checked-in/completed reservation or any session row), never a mere
// booking. `null` when the member has no qualifying activity yet.
export const recentBranchSchema = z
  .object({
    branchId: z.string(),
    branchName: z.string(),
    lastActivityAt: z.string(),
  })
  .nullable();
export type RecentBranch = z.infer<typeof recentBranchSchema>;

type MemberProfileRow = {
  id: string;
  tenantId: string;
  memberId: string;
  phone: string | null;
  memberCode: string | null;
  applicationStatus: string;
  appliedAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toMemberProfile(row: MemberProfileRow): MemberProfileDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    memberId: row.memberId,
    phone: row.phone,
    memberCode: row.memberCode,
    applicationStatus: row.applicationStatus as MemberApplicationStatus,
    appliedAt: row.appliedAt.toISOString(),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
