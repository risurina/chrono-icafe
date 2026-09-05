import type { ReactNode } from "react";
import { PageShell, Main } from "agora/ui";
import {
  MarketingHeader,
  MarketingFooter,
} from "@/components/landing/marketing-chrome";

/**
 * Shared shell for every standalone apex marketing page (`/download`,
 * `/support`, `/pricing`, `/terms`, `/privacy`, `/company/about`,
 * `/company/contact`, …) — mirrors `(saas-landing)/page.tsx`'s own apex-host
 * composition exactly, so every page under this route group only needs to
 * write its own content, not its own header/footer.
 *
 * Route groups are invisible in the URL: a `page.tsx` placed directly under
 * this directory (e.g. `(apex-marketing)/pricing/page.tsx`) resolves to
 * `/pricing`, not `/(apex-marketing)/pricing`.
 */
export default function ApexMarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const currentYear = new Date().getFullYear();

  return (
    <PageShell data-density="comfortable">
      <MarketingHeader />

      <Main>{children}</Main>

      <MarketingFooter year={currentYear} />
    </PageShell>
  );
}
