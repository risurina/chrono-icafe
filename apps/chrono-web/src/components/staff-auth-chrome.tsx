import { AuthPageChrome, Stack } from "agora/ui";
import { resolveAuthChromeContext } from "@/lib/auth-chrome";
import type { ChronoPublicBranding } from "@/lib/branding";
import { ChronoBrand } from "@/components/landing/chrono-brand";
import {
  MarketingHeader,
  MarketingFooter,
  TenantHeader,
  TenantFooter,
} from "@/components/landing/marketing-chrome";

/**
 * Header/footer chrome for the staff sign-in/up auth pages, branched apex vs.
 * tenant. Chrono's tenant-host staff sign-in lives at `/admin/login` (not
 * `/login`, which on a tenant host is the customer/member sign-in), and its
 * tenant-host customer sign-in is `/login` itself (not `/portal/login`) — see
 * `.ai/plans/chrono/archive/auth-page-header-footer/README.md`.
 *
 * The header and footer are the same rich `MarketingHeader`/`TenantHeader`
 * and `MarketingFooter`/`TenantFooter` the public pages use (full nav, brand
 * lockup, CTA; nav columns, brand blurb, "Powered by Chrono" bottom bar)
 * rather than `AuthPageChrome`'s generic built-in bar and one-liner, so an
 * auth page reads as the same site as `/` — a live-testing gap found after
 * this plan's original phases shipped.
 *
 * `MarketingHeader`/`TenantHeader` are `position: "fixed"` (out of document
 * flow, per `HEADER_PROPS` in `marketing-chrome.tsx`), so `AuthPageChrome`'s
 * own `<Main>` — `flex flex-1 items-center justify-center`, sized by
 * `PageShell`'s plain `min-h-screen` flex column, which has no notion that
 * the header is fixed — centers its child within the FULL viewport height,
 * including the 80px band the header physically overlays. `mt-20` (not
 * `pt-20`: padding would still count toward the box `min-h-[…]` below
 * defines, under Tailwind's `border-box` reset) pushes the box down by
 * exactly the header's height without inflating it, and
 * `min-h-[calc(100vh-5rem)]` (5rem = 80px = `h-20`, `HEADER_PROPS`'s bar
 * height) gives it the *remaining* viewport height rather than the full one.
 * The result: this box spans exactly from the header's bottom edge to the
 * viewport's bottom edge, and its own `flex items-center justify-center`
 * centers the page's content within THAT box — not the full page. Taller
 * content simply grows the box (and the page scrolls), which is correct.
 * Only Chrono knows its own header's height, so this lives here rather than
 * as a foundation-level offset prop for one caller's fixed-header choice.
 */
export async function StaffAuthChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await resolveAuthChromeContext();
  const currentYear = new Date().getFullYear();
  return (
    <AuthPageChrome
      context={context}
      surface="staff"
      apexBrand={<ChronoBrand />}
      apexProductName="Chrono"
      staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}
      customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"}
      header={
        context.kind === "apex" ? (
          <MarketingHeader />
        ) : (
          <TenantHeader
            tenantName={context.tenantName}
            displayName={context.branding?.displayName}
            logoUrl={context.branding?.logoUrl}
            logoDarkUrl={context.branding?.logoDarkUrl}
          />
        )
      }
      footer={
        context.kind === "apex" ? (
          <MarketingFooter year={currentYear} />
        ) : (
          <TenantFooter
            year={currentYear}
            tenantName={context.tenantName}
            tagline={context.branding?.tagline}
            hidePlatformBranding={
              (context.branding as ChronoPublicBranding | null)?.hidePlatformBranding
            }
          />
        )
      }
    >
      <Stack
        gap={0}
        className="mt-20 flex min-h-[calc(100vh-5rem)] w-full flex-col items-center justify-center"
      >
        {children}
      </Stack>
    </AuthPageChrome>
  );
}
