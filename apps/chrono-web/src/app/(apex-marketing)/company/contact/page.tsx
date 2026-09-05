import type { Metadata } from "next";
import { Section } from "agora/ui";
import { ContactForm } from "./contact-form";

/**
 * IZUR-the-vendor's own apex Contact page — a sales-qualification lead form,
 * distinct from the tenant's own inquiry form
 * (`(saas-landing)/contact/page.tsx`, untouched and unrelated). Renders
 * inside the `(apex-marketing)` route group's shared shell (`layout.tsx`),
 * which already supplies `MarketingHeader`/`MarketingFooter` — this file is
 * content only, plus the `contact-form.tsx` client component alongside it.
 *
 * Layout/copy reference (structure only, not ported, per this repo's
 * "improve, don't port oikos" rule): the oikos reference's
 * `~/karta/karta-tenant/apps/chrono-web/src/components/platform/landing/
 * forms/ContactForm.tsx` (its `!isTenant` branch). Its submission posts to
 * `/api/contact` guarded by reCAPTCHA; this page's form posts to the
 * already-built `POST /public/company-inquiries` endpoint
 * (`apps/chrono-api/src/modules/company-inquiry`, `source: "contact"`) and
 * relies on that endpoint's existing per-IP rate limiter instead of
 * reCAPTCHA — no such integration exists in this codebase (see
 * `.ai/plans/chrono/archive/apex-company-contact/README.md`, "Explicitly out
 * of scope"). Its raw `div`/hardcoded `gold`/`zinc-950` chrome is rebuilt
 * here from `agora/ui` primitives and semantic tokens, matching the sibling
 * `/support` page's established two-column look for this route group.
 */

export const metadata: Metadata = {
  title: "Contact — Chrono",
  description: "Talk to us about your inquiry.",
};

const EYEBROW = "text-[10px] font-black uppercase tracking-[0.3em] text-primary";

const CONTACT_BENEFITS = [
  "General inquiries",
  "Support requests",
  "Rates and membership",
  "Booking or events",
  "Feedback and suggestions",
] as const;

export default function CompanyContactPage() {
  return (
    <Section maxWidth="full" className="pb-16 pt-32">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start">
        <div>
          <span className={EYEBROW}>Contact</span>
          <h1 className="mb-6 mt-4 text-3xl font-black uppercase tracking-widest text-balance lg:text-5xl">
            Talk to IZUR about your cafe operations.
          </h1>
          <p className="mb-8 max-w-lg text-lg leading-8 text-muted-foreground">
            Tell us about your cafe setup, number of PCs, and rollout goals.
            We&apos;ll help you understand how Chrono can fit your workflow.
          </p>

          <div className="max-w-lg">
            <h4 className="mb-4 text-sm font-bold text-foreground">Best for:</h4>
            <ul className="mb-8 space-y-3">
              {CONTACT_BENEFITS.map((benefit) => (
                <li key={benefit} className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <span className="text-sm font-medium text-muted-foreground">{benefit}</span>
                </li>
              ))}
            </ul>

            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
              <p className="flex items-center gap-2 text-xs font-medium text-primary/80">
                <span
                  className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
                  aria-hidden
                />
                Chrono is built and supported by IZUR IT Solutions.
              </p>
            </div>
          </div>
        </div>

        <ContactForm />
      </div>
    </Section>
  );
}
