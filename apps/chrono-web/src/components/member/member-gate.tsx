"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CenteredMessage, Card, CardHeader, CardTitle, CardDescription } from "agora/ui";
import { useMemberSession } from "@/lib/member-client";
import { useGlobalCustomerSession } from "@/lib/customer-client";
import { MemberAreaProvider, useMemberArea } from "./member-area-context";
import { ApplyForTenantPrompt } from "./apply-for-tenant-prompt";
import { MemberHeader } from "./member-header";
import { MemberNav, MemberBottomNav } from "./member-nav";
import { MEMBER_NAV, matchMemberNav } from "./member-nav.config";
import { TenantFooter } from "@/components/landing/marketing-chrome";

function ApprovalRequiredCard({ status }: { status: string | undefined }) {
  const copy =
    status === "rejected"
      ? "Your membership application was not approved. Contact the business for help."
      : "Your membership application is still pending approval. Check back soon.";
  return (
    <CenteredMessage>
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Approval required</CardTitle>
          <CardDescription>{copy}</CardDescription>
        </CardHeader>
      </Card>
    </CenteredMessage>
  );
}

/** Route flagged `requiresApproval` and the member isn't approved yet →
 * `ApprovalRequiredCard`, else render. Only Promos/Leaderboard are flagged
 * (the plan's decision — `applicationStatus` enforces nothing elsewhere). */
function RouteGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { approved, onboarding, loaded } = useMemberArea();
  const entry = MEMBER_NAV.find((item) => matchMemberNav(pathname, item.href, item.exact));

  if (entry?.requiresApproval && loaded && !approved) {
    return <ApprovalRequiredCard status={onboarding?.applicationStatus} />;
  }
  return <>{children}</>;
}

function Chrome({
  tenantName,
  displayName,
  logoUrl,
  logoDarkUrl,
  tagline,
  children,
}: {
  tenantName: string;
  displayName?: string | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  tagline?: string | null;
  children: React.ReactNode;
}) {
  const { member } = useMemberArea();
  return (
    <div className="flex min-h-screen flex-col pb-16 md:pb-0">
      <MemberHeader
        tenantName={tenantName}
        displayName={displayName}
        logoUrl={logoUrl}
        logoDarkUrl={logoDarkUrl}
        member={member!}
      />
      <MemberNav />
      <main className="flex-1 p-4 md:p-6">
        <RouteGate>{children}</RouteGate>
      </main>
      <TenantFooter year={new Date().getFullYear()} tenantName={displayName ?? tenantName} tagline={tagline} />
      <MemberBottomNav />
    </div>
  );
}

/**
 * Gate cascade (moved from `tenant-portal-layout.tsx`, not duplicated):
 * 1. Sessions pending → skeleton shell.
 * 2. Neither member nor global customer → `/login?next=<path>`.
 * 3. Global customer only → `ApplyForTenantPrompt`.
 * 4. Member → one `GET /portal/members/me` (via `MemberAreaProvider`) → header + nav + `RouteGate`.
 */
export function MemberGate({
  tenantName,
  displayName,
  logoUrl,
  logoDarkUrl,
  tagline,
  children,
}: {
  tenantName: string;
  displayName?: string | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  tagline?: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { member, isPending } = useMemberSession();
  const { customer: globalCustomer, isPending: globalPending } = useGlobalCustomerSession();

  const bothResolved = !isPending && !globalPending;
  const canApply = bothResolved && !member && !!globalCustomer;

  useEffect(() => {
    if (bothResolved && !member && !globalCustomer) {
      const next = encodeURIComponent(pathname + (searchParams.size ? `?${searchParams}` : ""));
      location.href = `/login?next=${next}`;
    }
  }, [bothResolved, member, globalCustomer, pathname, searchParams]);

  if (!bothResolved) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  if (canApply) {
    return <ApplyForTenantPrompt />;
  }

  if (!member) {
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
      >
        {children}
      </Chrome>
    </MemberAreaProvider>
  );
}
