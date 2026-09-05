import { AuthPageChrome, Stack } from "agora/ui";
import { resolveAuthChromeContext } from "@/lib/auth-chrome";
import { ChronoBrand } from "@/components/landing/chrono-brand";
import {
  MarketingHeader,
  MarketingFooter,
  TenantHeader,
  TenantFooter,
} from "@/components/landing/marketing-chrome";

/**
 * `/login` is dual-purpose and host-branches at the page level: apex → staff
 * sign-in, tenant host → this business's own customer sign-in. So unlike
 * every other auth route, `surface` itself must be computed from
 * `context.kind` rather than fixed — this layout resolves `context` directly
 * instead of going through `StaffAuthChrome`/`PortalAuthChrome`. Covers both
 * `login/page.tsx` and the nested `login/verify-mfa/page.tsx`. See
 * `.ai/plans/chrono/archive/auth-page-header-footer/README.md`.
 *
 * Same rich header/footer, and the same `mt-20` + `min-h-[calc(100vh-5rem)]`
 * fixed-header clearance, as `StaffAuthChrome`/`PortalAuthChrome` — see that
 * file's comment for why.
 */
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await resolveAuthChromeContext();
  const currentYear = new Date().getFullYear();
  return (
    <AuthPageChrome
      context={context}
      surface={context.kind === "apex" ? "staff" : "portal"}
      staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}
      customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"}
      apexBrand={<ChronoBrand />}
      apexProductName="Chrono"
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
