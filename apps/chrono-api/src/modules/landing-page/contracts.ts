import { z } from "zod";

// ctaHref is tenant-authored input rendered into a public anchor href, never
// server-fetched — the risk is XSS (javascript:/data: schemes), not SSRF, so
// this only accepts an https:// absolute URL or a same-origin relative path
// beginning "/" (and not "//", which browsers resolve as protocol-relative).
// See .ai/plans/chrono/active/security-hardening/README.md, Phase 5.
const ctaHrefSchema = z
  .string()
  .refine(
    (v) => {
      if (v.startsWith("/") && !v.startsWith("//")) return true;
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "ctaHref must be an https:// URL or a same-origin path starting with /." },
  );

export const updateLandingPageSchema = z
  .object({
    heroTagline: z.string().nullable().optional(),
    aboutBody: z.string().nullable().optional(),
    amenitiesBody: z.string().nullable().optional(),
    contactOverride: z.string().nullable().optional(),
    ctaLabel: z.string().nullable().optional(),
    ctaHref: ctaHrefSchema.nullable().optional(),
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
