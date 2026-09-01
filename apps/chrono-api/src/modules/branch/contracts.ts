import { z } from "zod";

export const branchStatusSchema = z.enum(['active', 'disabled']);

export const branchSocialLinksSchema = z
  .object({
    facebook: z.string().url().max(2048).nullable().optional(),
    messenger: z.string().url().max(2048).nullable().optional(),
    instagram: z.string().url().max(2048).nullable().optional(),
    tiktok: z.string().url().max(2048).nullable().optional(),
    discord: z.string().url().max(2048).nullable().optional(),
  })
  .optional();

export const createBranchSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50).optional(),
  status: branchStatusSchema.optional(),
  address: z.string().max(255).optional(),
  contactNumber: z.string().max(50).optional(),
  email: z.string().email().max(255).optional(),
  operatingHours: z.string().max(255).optional(),
  timezone: z.string().min(1).max(50).optional(),
  latitude: z.string().max(20).optional(),
  longitude: z.string().max(20).optional(),
  googleMapsUrl: z.string().url().max(2048).optional(),
  socialLinks: branchSocialLinksSchema,
});

export const updateBranchSchema = createBranchSchema.partial();

export type BranchStatus = z.infer<typeof branchStatusSchema>;
export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
