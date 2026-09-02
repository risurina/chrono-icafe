import { z } from "zod";
import { listQuerySchema } from "agora";

// Public (unauthenticated) categories only — see Decision 1 in the plan.
export const publicInquiryCategorySchema = z.enum(["general", "lost_and_found", "feedback"]);
// Portal (authenticated tenantMember) categories — superset of the public ones.
export const portalInquiryCategorySchema = z.enum([
  "general",
  "lost_and_found",
  "feedback",
  "billing",
  "session_issue",
  "account",
]);

export const inquiryStatusSchema = z.enum(["new", "assigned", "in_progress", "resolved", "closed"]);

export const submitPublicInquirySchema = z.object({
  submitterName: z.string().min(1).max(255),
  submitterEmail: z.string().email(),
  submitterPhone: z.string().max(50).optional(),
  category: publicInquiryCategorySchema,
  subject: z.string().min(1).max(255),
  message: z.string().min(1).max(4000),
});

export const submitPortalInquirySchema = z.object({
  category: portalInquiryCategorySchema,
  subject: z.string().min(1).max(255),
  message: z.string().min(1).max(4000),
});

export const replyToInquirySchema = z.object({
  body: z.string().min(1).max(4000),
});

// Staff-only: assigns to the calling staff user by default (no body), or an
// explicit staff user id (validated by the route to be a member of the same
// tenant before it is trusted).
export const assignInquirySchema = z.object({
  assignedToUserId: z.string().min(1).optional(),
});

export const updateInquiryStatusSchema = z.object({
  status: z.enum(["assigned", "in_progress", "resolved", "closed"]),
});

export const inquiryListQuerySchema = listQuerySchema(["createdAt", "updatedAt"]).extend({
  status: inquiryStatusSchema.optional(),
  category: portalInquiryCategorySchema.optional(),
  assignedToUserId: z.string().optional(),
});

export type PublicInquiryCategory = z.infer<typeof publicInquiryCategorySchema>;
export type PortalInquiryCategory = z.infer<typeof portalInquiryCategorySchema>;
export type InquiryStatus = z.infer<typeof inquiryStatusSchema>;
export type SubmitPublicInquiryInput = z.infer<typeof submitPublicInquirySchema>;
export type SubmitPortalInquiryInput = z.infer<typeof submitPortalInquirySchema>;
export type ReplyToInquiryInput = z.infer<typeof replyToInquirySchema>;
export type AssignInquiryInput = z.infer<typeof assignInquirySchema>;
export type UpdateInquiryStatusInput = z.infer<typeof updateInquiryStatusSchema>;
export type InquiryListQuery = z.infer<typeof inquiryListQuerySchema>;
