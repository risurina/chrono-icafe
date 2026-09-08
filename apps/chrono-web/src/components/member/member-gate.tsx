"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CenteredMessage } from "agora/ui";
import { useMemberSession } from "@/lib/member-client";
import { useGlobalCustomerSession } from "@/lib/customer-client";
import { MemberAreaProvider, useMemberArea } from "./member-area-context";
import { MemberAccessBanner } from "./member-access-banner";
import { MemberHeader } from "./member-header";
import { MemberNav, MemberBottomNav } from "./member-nav";
import { TenantFooter } from "@/components/landing/marketing-chrome";

function Chrome({
  tenantName,
  displayName,
  logoUrl,
  logoDarkUrl,
  tagline,
  hidePlatformBranding,
  identity,
  guestMode,
  children,
}: {
  tenantName: string;
  displayName?: string | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  tagline?: string | null;
  hidePlatformBranding?: boolean;
  identity: { name: string; email: string };
  guestMode: boolean;
  children: React.ReactNode;
}) {
  const { approved, onboarding, loaded } = useMemberArea();
  const showPendingBanner = !guestMode && loaded && !approved && onboarding?.applicationStatus === "pending";

  return (
    // `MemberHeader` (`TenantHeader`) is fixed/80px, not sticky — content
    // reserves its own top padding instead of relying on document flow.
    <div className="flex min-h-screen flex-col pb-16 pt-20 md:pb-0">
      <MemberHeader
        tenantName={tenantName}
        displayName={displayName}
        logoUrl={logoUrl}
        logoDarkUrl={logoDarkUrl}
        identity={identity}
      />
      <MemberNav />
      {guestMode && <MemberAccessBanner variant="not-applied" />}
      {showPendingBanner && <MemberAccessBanner variant="pending" />}
      <main className="mx-auto w-full flex flex-col max-w-7xl flex-1 p-4 md:py-6 md:px-10">
        {children}
      </main>
      <TenantFooter
        year={new Date().getFullYear()}
        tenantName={displayName ?? tenantName}
        tagline={tagline}
        hidePlatformBranding={hidePlatformBranding}
      />
      <MemberBottomNav />
    </div>
  );
}

/**
 * Gate cascade (moved from `tenant-portal-layout.tsx`, not duplicated):
 * 1. Sessions pending → skeleton shell.
 * 2. Neither member nor global customer → `/login?next=<path>`.
 * 3. Global customer only (not yet applied to this tenant) → guest-mode
 *    `Chrome` with a "Join this business" banner (Phase 2 locks the
 *    member-only page content behind `RequiresMembership`; Phase 1 leaves
 *    guest-mode pages calling their existing data hooks, which 401 today).
 * 4. Member → one `GET /portal/members/me` (via `MemberAreaProvider`) → header + nav + banner (if pending) + page.
 */
export function MemberGate({
  tenantName,
  displayName,
  logoUrl,
  logoDarkUrl,
  tagline,
  hidePlatformBranding,
  children,
}: {
  tenantName: string;
  displayName?: string | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  tagline?: string | null;
  hidePlatformBranding?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { member, isPending } = useMemberSession();
  const { customer: globalCustomer, isPending: globalPending } = useGlobalCustomerSession();

  const bothResolved = !isPending && !globalPending;
  const guestMode = bothResolved && !member && !!globalCustomer;

  useEffect(() => {
    if (bothResolved && !member && !globalCustomer) {
      const next = encodeURIComponent(pathname + (searchParams.size ? `?${searchParams}` : ""));
      location.href = `/login?next=${next}`;
    }
  }, [bothResolved, member, globalCustomer, pathname, searchParams]);

  if (!bothResolved) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  if (!member && !globalCustomer) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  const identity = member ?? globalCustomer;
  if (!identity) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  return (
    <MemberAreaProvider member={member}>
      <Chrome
        tenantName={tenantName}
        displayName={displayName}
        logoUrl={logoUrl}
        logoDarkUrl={logoDarkUrl}
        tagline={tagline}
        hidePlatformBranding={hidePlatformBranding}
        identity={identity}
        guestMode={guestMode}
      >
        {children}
      </Chrome>
    </MemberAreaProvider>
  );
}
