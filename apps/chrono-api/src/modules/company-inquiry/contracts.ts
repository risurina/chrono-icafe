import { z } from "zod";

// Discriminates which public page a submission came from — both share this
// one endpoint (`/public/company-inquiries`) rather than each minting its own.
// `support` (apex-support-page) never sends the two count fields below;
// `contact` (apex-company-contact) sends them when the visitor supplies them.
export const companyInquirySourceSchema = z.enum(["support", "contact"]);

export const submitCompanyInquirySchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  businessName: z.string().min(1).max(255).optional(),
  // Free text (mirroring the oikos reference's "Demo, Setup, etc."
  // placeholder), not an enum — IZUR's own intake categories aren't fixed yet.
  requestType: z.string().min(1).max(255),
  message: z.string().min(1).max(4000),
  numberOfPcs: z.number().int().positive().optional(),
  numberOfBranches: z.number().int().positive().optional(),
  source: companyInquirySourceSchema,
});

export type CompanyInquirySource = z.infer<typeof companyInquirySourceSchema>;
export type SubmitCompanyInquiryInput = z.infer<typeof submitCompanyInquirySchema>;
