import type { Metadata } from "next";
import { Section } from "agora/ui";
import { FaqAccordion } from "@/components/landing/faq-accordion";
import { SupportForm } from "./support-form";

/**
 * Static apex Support page. Renders inside the `(apex-marketing)` route
 * group's shared shell (`layout.tsx`), which already supplies
 * `MarketingHeader`/`MarketingFooter` — this file is content only, plus the
 * `support-form.tsx` client component alongside it.
 *
 * Layout/copy reference (structure only, not ported): the oikos reference's
 * `~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/support/
 * {page.tsx,support-client.tsx}` — its submission is simulated (`setTimeout`,
 * no backend); this page's form posts to a real endpoint
 * (`POST /public/company-inquiries`, `apps/chrono-api/src/modules/
 * company-inquiry`). Its raw `div`/hardcoded `gold`/`zinc-950` chrome and its
 * FAQ section are rebuilt here from `agora/ui` primitives plus the existing
 * local `FaqAccordion` (`apps/chrono-web/src/components/landing/
 * faq-accordion.tsx`, already used by the homepage's own FAQ section) —
 * consistent with the marketing site's own established look rather than
 * `agora/ui`'s plain, business-neutral `FaqItem`.
 */

export const metadata: Metadata = {
  title: "Support — Chrono",
  description:
    "Get support for Chrono setup, demos, and internet cafe operations workflows.",
};

const EYEBROW = "text-[10px] font-black uppercase tracking-[0.3em] text-primary";

const SUPPORT_PATHS = [
  { title: "Setup guidance", description: "Get help configuring your initial setup." },
  { title: "Demo request", description: "Request a private demo of Chrono." },
  { title: "Account help", description: "Help with your existing Chrono account." },
  {
    title: "Workflow consultation",
    description: "Discuss multi-branch operations and rollout.",
  },
] as const;

const SUPPORT_FAQS = [
  {
    q: "How do I request a demo?",
    a: "Send a request through the form below specifying you'd like a demo, and our team will get in touch to schedule a session.",
  },
  {
    q: "Can IZUR help with setup?",
    a: "Yes — we offer setup support to help you get your cafe running smoothly.",
  },
  {
    q: "Do you support multi-branch cafe planning?",
    a: "Absolutely. Let us know how many branches you operate in the form below.",
  },
  {
    q: "What should I include in a support request?",
    a: "Include your business name, current setup size, and specific questions or issues.",
  },
] as const;

export default function SupportPage() {
  return (
    <>
      <Section maxWidth="full" border="bottom" className="pb-16 pt-32">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start">
          <div>
            <span className={EYEBROW}>Support</span>
            <h1 className="mb-6 mt-4 text-3xl font-black uppercase tracking-widest text-balance lg:text-5xl">
              Get help with your Chrono rollout.
            </h1>
            <p className="mb-12 max-w-lg text-lg leading-8 text-muted-foreground">
              Whether you are exploring Chrono, setting up your first cafe, or
              planning a multi-branch rollout, IZUR can help you choose the
              next best step.
            </p>

            <div className="grid max-w-lg grid-cols-1 gap-4 sm:grid-cols-2">
              {SUPPORT_PATHS.map((path) => (
                <div
                  key={path.title}
                  className="rounded-2xl border border-border bg-muted/30 p-5 transition-colors hover:bg-muted/50"
                >
                  <h4 className="mb-2 text-sm font-bold text-foreground">
                    {path.title}
                  </h4>
                  <p className="text-xs text-muted-foreground">{path.description}</p>
                </div>
              ))}
            </div>
          </div>

          <SupportForm />
        </div>
      </Section>

      <Section maxWidth="full">
        <div className="py-20">
          <FaqAccordion
            eyebrow="FAQ"
            title="Common questions"
            description="Answers to what IZUR support gets asked most."
            faqs={SUPPORT_FAQS.map((faq) => ({ q: faq.q, a: faq.a }))}
          />
        </div>
      </Section>
    </>
  );
}
