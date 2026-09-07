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
 * Header/footer chrome for the customer portal auth pages, branched apex vs.
 * tenant. Same href overrides and rich header/footer reuse as
 * `StaffAuthChrome` — see
 * `.ai/plans/chrono/archive/auth-page-header-footer/README.md`. Same
 * `mt-20` + `min-h-[calc(100vh-5rem)]` fixed-header clearance too — see
 * `StaffAuthChrome`'s comment for why.
 */
export async function PortalAuthChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await resolveAuthChromeContext();
  const currentYear = new Date().getFullYear();
  return (
    <AuthPageChrome
      context={context}
      surface="portal"
      apexBrand={<ChronoBrand />}
      apexProductName="Chrono"
      staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}
      customerLoginHref={context.kind === "apex" ? "/member/login" : "/login"}
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
