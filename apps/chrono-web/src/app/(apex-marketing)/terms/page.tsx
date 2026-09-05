import type { Metadata } from "next";
import { Section, Stack } from "agora/ui";

/**
 * Static Terms of Service page. Renders inside the `(apex-marketing)` route
 * group's shared shell (`layout.tsx`), which already supplies
 * `MarketingHeader`/`MarketingFooter` — this file is content only.
 *
 * Copy carried forward from the oikos reference
 * (`~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/terms/page.tsx`),
 * per `.ai/plans/chrono/ready/apex-legal-pages/README.md`'s Open Question 1
 * default ("carry the reference copy forward"), with only the "Last updated"
 * date refreshed.
 */

export const metadata: Metadata = {
  title: "Terms of Service — Chrono",
  description: "Terms for using Chrono by IZUR.",
};

const EYEBROW = "text-[10px] font-black uppercase tracking-[0.3em] text-primary";
const LAST_UPDATED =
  "text-sm font-bold uppercase tracking-widest text-primary";

const SECTIONS = [
  {
    title: "Use of service",
    body: "Chrono is provided for legitimate internet cafe operations, including session management, payment tracking, staff workflows, and operational reporting.",
  },
  {
    title: "Account responsibility",
    body: "Customers are responsible for maintaining accurate account information, protecting login credentials, and assigning staff permissions appropriately.",
  },
  {
    title: "Operational data",
    body: "Cafe owners are responsible for the accuracy of operational records entered by their team, including manual payments, notes, and customer balances.",
  },
  {
    title: "Changes and support",
    body: "IZUR may update Chrono features, policies, and support processes as the platform evolves. For questions, contact support.",
  },
] as const;

export default function TermsPage() {
  return (
    <Section maxWidth="lg" className="pb-24 pt-32">
      <div className="mx-auto max-w-3xl">
        <div className="mb-12 border-b border-border pb-12">
          <span className={EYEBROW}>Terms of Service</span>
          <h1 className="mb-6 mt-4 text-3xl font-black uppercase tracking-widest text-balance lg:text-5xl">
            Terms for using Chrono.
          </h1>
          <p className={LAST_UPDATED}>Last updated: September 5, 2026</p>
        </div>

        <Stack gap={8}>
          {SECTIONS.map((section) => (
            <div
              key={section.title}
              className="border-b border-border pb-8 last:border-0 last:pb-0"
            >
              <h2 className="mb-4 text-xl font-black uppercase tracking-widest text-foreground">
                {section.title}
              </h2>
              <p className="leading-relaxed text-muted-foreground">
                {section.body}
              </p>
            </div>
          ))}
        </Stack>
      </div>
    </Section>
  );
}
