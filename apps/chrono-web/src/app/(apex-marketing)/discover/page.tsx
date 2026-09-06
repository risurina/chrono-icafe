import { Suspense } from "react";
import { Section } from "agora/ui";
import { DiscoverSearch } from "./discover-search";

/**
 * Apex `/discover` — the player-facing half of the two-sided growth loop.
 *
 * Renders inside the `(apex-marketing)` route group's shared shell
 * (`layout.tsx`), which already supplies `MarketingHeader`/`MarketingFooter`,
 * so this file is content only — same shape as the sibling `support/page.tsx`.
 *
 * This is a real interactive route rather than a homepage section because it
 * has genuine behaviour (a cross-tenant search plus a form), not marketing
 * copy. The player-value and partner-value pitches stay on the homepage as
 * anchors.
 *
 * `metadata` is added in Phase 5 alongside the homepage's own SEO pass.
 */

const EYEBROW = "text-[10px] font-black uppercase tracking-[0.3em] text-primary";

export default function DiscoverPage() {
  return (
    <Section maxWidth="full" className="pb-24 pt-32">
      <div className="mx-auto max-w-3xl">
        <span className={EYEBROW}>Discover</span>
        <h1 className="mb-6 mt-4 text-3xl font-black uppercase tracking-widest text-balance lg:text-5xl">
          Find your gaming café.
        </h1>
        <p className="mb-12 text-lg leading-8 text-muted-foreground">
          Search the gaming businesses already on Chrono. If yours isn&apos;t
          here yet, tell us — the more players ask for a café, the stronger the
          case when we reach them.
        </p>

        {/* `DiscoverSearch` reads `?invite=1` via `useSearchParams`, which Next
            requires to sit inside a Suspense boundary. */}
        <Suspense fallback={null}>
          <DiscoverSearch />
        </Suspense>
      </div>
    </Section>
  );
}
