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

// Response DTO — explicit column list, dates as ISO strings (.ai/rules/dto.md).
export const branchDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  code: z.string(),
  status: branchStatusSchema,
  address: z.string().nullable(),
  contactNumber: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  operatingHours: z.string().nullable(),
  googleMapsUrl: z.string().nullable(),
  socialLinks: branchSocialLinksSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BranchDto = z.infer<typeof branchDtoSchema>;

type BranchRow = {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  status: string;
  address: string | null;
  contactNumber: string | null;
  email: string | null;
  timezone: string;
  latitude: string | null;
  longitude: string | null;
  operatingHours: string | null;
  googleMapsUrl: string | null;
  socialLinks: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export function toBranchDto(row: BranchRow): BranchDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    code: row.code,
    status: row.status as BranchStatus,
    address: row.address,
    contactNumber: row.contactNumber,
    email: row.email,
    timezone: row.timezone,
    latitude: row.latitude,
    longitude: row.longitude,
    operatingHours: row.operatingHours,
    googleMapsUrl: row.googleMapsUrl,
    socialLinks: row.socialLinks as BranchDto["socialLinks"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
