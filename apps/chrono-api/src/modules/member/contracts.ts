import { z } from "zod";

export const memberApplicationStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const applyForMembershipSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

export const updateMemberProfileSchema = z.object({
  phone: z.string().min(1).max(50).optional(),
});

export type MemberApplicationStatus = z.infer<typeof memberApplicationStatusSchema>;
export type ApplyForMembershipInput = z.infer<typeof applyForMembershipSchema>;
export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileSchema>;
