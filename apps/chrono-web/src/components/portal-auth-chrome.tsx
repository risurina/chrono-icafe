import { AuthPageChrome } from "agora/ui";
import { resolveAuthChromeContext } from "@/lib/auth-chrome";
import { ChronoBrand } from "@/components/landing/chrono-brand";

/**
 * Header/footer chrome for the customer portal auth pages, branched apex vs.
 * tenant. Same href overrides as `StaffAuthChrome` — see
 * `.ai/plans/chrono/active/auth-page-header-footer/README.md`.
 */
export async function PortalAuthChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await resolveAuthChromeContext();
  return (
    <AuthPageChrome
      context={context}
      surface="portal"
      apexBrand={<ChronoBrand />}
      apexProductName="Chrono"
      staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}
      customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"}
    >
      {children}
    </AuthPageChrome>
  );
}
