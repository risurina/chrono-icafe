"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CenteredMessage } from "agora/ui";
import { useMemberSession } from "@/lib/member-client";
import { useGlobalCustomerSession, applyForTenantMembership } from "@/lib/customer-client";
import { registerVisit } from "@/lib/member/account";
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
      {showPendingBanner && <MemberAccessBanner />}
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
 * 3. Global customer only (not yet applied to this tenant) → silently
 *    registers them as a `"visitor"` (member-visitor-status-tier): calls the
 *    foundation's `applyForTenantMembership()` (creates the `tenantMember`
 *    row, instant access) then `registerVisit()` (creates a Chrono
 *    `chronoMemberProfile` row with `applicationStatus: "visitor"`), then
 *    reloads so `useMemberSession()` resolves a real `member` on the next
 *    request. If either call fails, this falls back to `guestMode` Chrome
 *    with `member: null` — today's guest rendering — rather than retrying in
 *    a loop; each page already treats `member === null` as "skip member-only
 *    fetches".
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

  // Silent visitor auto-registration — fires at most once per mount (a ref,
  // not state, so a re-render never re-triggers it) and never retries on
  // failure; a failed attempt just leaves `guestMode` Chrome in place until
  // the next mount (e.g. navigating to another `/member/*` page tries again).
  const attemptedVisitorRegistration = useRef(false);
  useEffect(() => {
    if (!guestMode) return;
    if (attemptedVisitorRegistration.current) return;
    attemptedVisitorRegistration.current = true;
    void (async () => {
      const { error: joinError } = await applyForTenantMembership();
      if (joinError) return;
      const { error: visitError } = await registerVisit();
      if (visitError) return;
      location.reload();
    })();
  }, [guestMode]);

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
