import { ChevronDown } from "lucide-react";
import { SectionHeading, Stack } from "agora/ui";

export type FaqAccordionEntry = { q: string; a: string };

function FaqAccordionItem({ q, a }: FaqAccordionEntry) {
  return (
    <details className="group rounded-xl bg-secondary px-6 py-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-xs font-bold uppercase tracking-widest text-secondary-foreground marker:content-none">
        {q}
        <ChevronDown
          className="h-4 w-4 shrink-0 text-primary transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
        {a}
      </div>
    </details>
  );
}

/**
 * Chrono's own FAQ layout — heading beside a stack of rounded accordion
 * cards, matching the reference site's "Information Desk" section. Chrono-
 * local: the gold/dark rounded card is specific to Chrono's premium-gold
 * identity, not a generic foundation pattern — `agora/ui`'s `FaqItem` stays
 * the plain, business-neutral bottom-border version for `apps/agora-web` and
 * a tenant's own configurable landing FAQ (`TenantFaq`).
 */
export function FaqAccordion({
  eyebrow,
  title,
  description,
  faqs,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  faqs: FaqAccordionEntry[];
}) {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,320px)_1fr] lg:gap-16">
      <SectionHeading eyebrow={eyebrow} title={title} description={description} />
      <Stack gap={3}>
        {faqs.map((faq) => (
          <FaqAccordionItem key={faq.q} {...faq} />
        ))}
      </Stack>
    </div>
  );
}
