import { AuthPageChrome } from "agora/ui";
import { resolveAuthChromeContext } from "@/lib/auth-chrome";
import { ChronoBrand } from "@/components/landing/chrono-brand";

/**
 * Header/footer chrome for the staff sign-in/up auth pages, branched apex vs.
 * tenant. Chrono's tenant-host staff sign-in lives at `/admin/login` (not
 * `/login`, which on a tenant host is the customer/member sign-in), and its
 * tenant-host customer sign-in is `/login` itself (not `/portal/login`) — see
 * `.ai/plans/chrono/active/auth-page-header-footer/README.md`.
 */
export async function StaffAuthChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await resolveAuthChromeContext();
  return (
    <AuthPageChrome
      context={context}
      surface="staff"
      apexBrand={<ChronoBrand />}
      apexProductName="Chrono"
      staffLoginHref={context.kind === "apex" ? "/login" : "/admin/login"}
      customerLoginHref={context.kind === "apex" ? "/portal/login" : "/login"}
    >
      {children}
    </AuthPageChrome>
  );
}
