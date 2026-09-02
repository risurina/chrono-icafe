import { z } from "zod";

export const updateLandingPageSchema = z
  .object({
    heroTagline: z.string().nullable().optional(),
    aboutBody: z.string().nullable().optional(),
    amenitiesBody: z.string().nullable().optional(),
    contactOverride: z.string().nullable().optional(),
    ctaLabel: z.string().nullable().optional(),
    ctaHref: z.string().url().nullable().optional(),
  })
  .strict();

export type UpdateLandingPageInput = z.infer<typeof updateLandingPageSchema>;

export interface BranchSummary {
  id: string;
  name: string;
  address: string | null;
  operatingHours: string | null;
  contactNumber: string | null;
  email: string | null;
}

export interface LandingPageContent {
  heroTagline: string | null;
  aboutBody: string | null;
  amenitiesBody: string | null;
  contactOverride: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
}

export interface PublicLandingPageResponse {
  content: LandingPageContent | null;
  branches: BranchSummary[];
  hasStations: boolean;
  tenantName: string;
}
