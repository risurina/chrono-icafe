import type { Metadata } from "next";
import { Section, Stack } from "agora/ui";

/**
 * Static Privacy Policy page. Renders inside the `(apex-marketing)` route
 * group's shared shell (`layout.tsx`), which already supplies
 * `MarketingHeader`/`MarketingFooter` — this file is content only.
 *
 * Copy carried forward from the oikos reference
 * (`~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/privacy/page.tsx`),
 * per `.ai/plans/chrono/ready/apex-legal-pages/README.md`'s Open Question 1
 * default ("carry the reference copy forward"), with only the "Last updated"
 * date refreshed.
 */

export const metadata: Metadata = {
  title: "Privacy Policy — Chrono",
  description: "Privacy information for Chrono by IZUR.",
};

const EYEBROW = "text-[10px] font-black uppercase tracking-[0.3em] text-primary";
const LAST_UPDATED =
  "text-sm font-bold uppercase tracking-widest text-primary";

const SECTIONS = [
  {
    title: "Information we collect",
    body: "Chrono may collect account details, cafe profile information, operational records, usage data, and support messages needed to provide the service.",
  },
  {
    title: "How we use information",
    body: "We use information to operate the platform, secure accounts, provide support, improve workflows, and maintain auditability for cafe operations.",
  },
  {
    title: "Data protection",
    body: "We apply access controls, authentication, and operational safeguards to protect platform data. Cafe owners are responsible for managing staff access appropriately.",
  },
  {
    title: "Contact",
    body: "For privacy questions or requests, contact IZUR through the support or contact page.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <Section maxWidth="full" className="pb-24 pt-32">
      <div className="mx-auto max-w-3xl">
        <div className="mb-12 border-b border-border pb-12">
          <span className={EYEBROW}>Privacy Policy</span>
          <h1 className="mb-6 mt-4 text-3xl font-black uppercase tracking-widest text-balance lg:text-5xl">
            How Chrono handles platform data.
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
