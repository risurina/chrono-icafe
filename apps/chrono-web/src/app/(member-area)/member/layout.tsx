import { getRequestTenant } from "@/lib/tenant";
import { getPublicBranding } from "@/lib/branding";
import { MemberGate } from "@/components/member/member-gate";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function fetchTenantName(): Promise<string> {
  const t = await getRequestTenant();
  const headers: Record<string, string> = {};
  if (t.slug) headers["x-tenant-slug"] = t.slug;
  else if (t.host) headers["x-tenant-host"] = t.host;
  try {
    const res = await fetch(`${API_URL}/public/tenant`, { headers, cache: "no-store" });
    if (!res.ok) return "";
    return (await res.json()).tenant?.name ?? "";
  } catch {
    return "";
  }
}

/**
 * `/member/*` route group layout — server component: resolves the tenant +
 * public branding, then hands off to the client `<MemberGate>` for the
 * session/approval gate cascade (see `.ai/rules/architecture.md` — no
 * middleware, tenant resolved via `getRequestTenant()`).
 */
export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const [tenantName, branding] = await Promise.all([fetchTenantName(), getPublicBranding()]);

  return (
    <MemberGate
      tenantName={branding?.displayName?.trim() || tenantName}
      displayName={branding?.displayName}
      logoUrl={branding?.logoUrl}
      logoDarkUrl={branding?.logoDarkUrl}
      tagline={branding?.tagline}
      hidePlatformBranding={branding?.hidePlatformBranding}
    >
      {children}
    </MemberGate>
  );
}
