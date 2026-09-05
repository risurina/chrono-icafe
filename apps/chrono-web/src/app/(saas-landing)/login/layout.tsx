import { AuthPageChrome } from "agora/ui";
import { resolveAuthChromeContext } from "@/lib/auth-chrome";
import { ChronoBrand } from "@/components/landing/chrono-brand";

/**
 * `/login` is dual-purpose and host-branches at the page level: apex → staff
 * sign-in, tenant host → this business's own customer sign-in. So unlike
 * every other auth route, `surface` itself must be computed from
 * `context.kind` rather than fixed — this layout resolves `context` directly
 * instead of going through `StaffAuthChrome`/`PortalAuthChrome`. Covers both
 * `login/page.tsx` and the nested `login/verify-mfa/page.tsx`. See
 * `.ai/plans/chrono/active/auth-page-header-footer/README.md`.
 */
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await resolveAuthChromeContext();
  return (
    <AuthPageChrome
      context={context}
      surface={context.kind === "apex" ? "staff" : "portal"}
      staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}
      customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"}
      apexBrand={<ChronoBrand />}
      apexProductName="Chrono"
    >
      {children}
    </AuthPageChrome>
  );
}
