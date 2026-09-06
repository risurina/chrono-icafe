import { z } from "zod";
import type { HoursConfig } from "./hours";

export const branchStatusSchema = z.enum(['active', 'disabled']);

// ---------------------------------------------------------------------------
// Structured operating hours (`hoursConfig`). Parsed by `computeOpenStatus`
// (./hours.ts). `operatingHours` (free text) stays permanently alongside this
// as a tenant-editable supplementary note — never deprecated or replaced.
// ---------------------------------------------------------------------------

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, e.g. 09:00");

export const dayHoursSchema = z.union([
  z.object({ open: timeOfDaySchema, close: timeOfDaySchema }),
  z.literal("24h"),
  z.literal("closed"),
]);

export const hoursConfigSchema = z
  .object({
    sunday: dayHoursSchema.optional(),
    monday: dayHoursSchema.optional(),
    tuesday: dayHoursSchema.optional(),
    wednesday: dayHoursSchema.optional(),
    thursday: dayHoursSchema.optional(),
    friday: dayHoursSchema.optional(),
    saturday: dayHoursSchema.optional(),
  })
  .strict();

export type DayHours = z.infer<typeof dayHoursSchema>;
export type HoursConfigInput = z.infer<typeof hoursConfigSchema>;

/** The computed, point-in-time status derived from `hoursConfig` + `timezone`. */
export const openStatusSchema = z.object({
  isOpen: z.boolean(),
  opensAt: z.string().nullable(),
});
export type OpenStatusDto = z.infer<typeof openStatusSchema>;

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
  hoursConfig: hoursConfigSchema.nullable().optional(),
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
  hoursConfig: hoursConfigSchema.nullable(),
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
  hoursConfig: unknown;
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
    hoursConfig: (row.hoursConfig as HoursConfig | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public (unauthenticated) venue info — the tenant's own public site reads this
// for its business-info and rates sections. Deliberately narrow: only
// tenant-authored, already-public marketing fields, never a raw row
// (`.ai/rules/dto.md`). One small single-purpose public route, matching the
// convention `/public/tenant`, `/public/branding`, `/public/stations` already
// follow — rather than widening `/public/stations`.
// ---------------------------------------------------------------------------

export const publicVenueBranchSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  googleMapsUrl: z.string().nullable(),
  operatingHours: z.string().nullable(),
  contactNumber: z.string().nullable(),
  email: z.string().nullable(),
  socialLinks: branchSocialLinksSchema.nullable(),
  // The raw structured config (for a future dashboard editor / debugging) plus
  // the already-computed status — `null` on both when the tenant has not
  // configured structured hours yet, so the public page falls back to the
  // plain-text `operatingHours` display above rather than fabricating one.
  hoursConfig: hoursConfigSchema.nullable(),
  openStatus: openStatusSchema.nullable(),
});

/**
 * A published rate. `hourlyRate`/`memberRate` are Drizzle `numeric` columns and
 * cross the wire as strings, like every other money field in this app.
 */
export const publicVenueRateGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  hourlyRate: z.string(),
  memberRate: z.string().nullable(),
});

export const publicVenueInfoResponseSchema = z.object({
  branch: publicVenueBranchSchema.nullable(),
  rateGroups: z.array(publicVenueRateGroupSchema),
});

export type PublicVenueBranch = z.infer<typeof publicVenueBranchSchema>;
export type PublicVenueRateGroup = z.infer<typeof publicVenueRateGroupSchema>;
export type PublicVenueInfoResponse = z.infer<typeof publicVenueInfoResponseSchema>;
