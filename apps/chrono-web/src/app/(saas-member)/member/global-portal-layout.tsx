"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { ThemeToggle, IdentityMenu, CenteredMessage, Row } from "agora/ui";
import { customerAuth, useGlobalCustomerSession } from "@/lib/customer-client";
import { MarketingHeader, MarketingFooter } from "@/components/landing/marketing-chrome";
import { GlobalPortalSidebar } from "@/components/member/global-portal-sidebar";

// `/member/accept-invite` is a tenant-member invite link (hardcoded in
// foundation emails, kept at this path per the plan) that renders its own
// `memberAuth`-based flow regardless of host — it must not be gated behind a
// global-customer session.
const PUBLIC = [
  "/member/login",
  "/member/sign-up",
  "/member/forgot",
  "/member/reset",
  "/member/accept-invite",
];

/** Shell for the global customer identity's own apex-level pages. */
export function GlobalPortalLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC.includes(pathname);
  const { customer, isPending } = useGlobalCustomerSession();

  useEffect(() => {
    if (!isPublic && !isPending && !customer) location.href = "/member/login";
  }, [isPublic, isPending, customer]);

  if (isPublic) return <>{children}</>;

  if (isPending || !customer) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader
        actions={
          <Row items="center" gap={2}>
            <Row className="hidden sm:flex">
              <ThemeToggle />
            </Row>
            <IdentityMenu
              name={customer.name}
              email={customer.email}
              items={[]}
              triggerTestId="global-customer-user-menu-trigger"
              onSignOut={async () => {
                await customerAuth.signOut();
                location.href = "/member/login";
              }}
            />
          </Row>
        }
      />
      {/* `MarketingHeader` is fixed/80px, not sticky — content reserves its
          own top padding instead of relying on document flow. */}
      <main className="flex-1 pt-24">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 py-8 sm:flex-row">
          <GlobalPortalSidebar name={customer.name} email={customer.email} />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </main>
      <MarketingFooter year={new Date().getFullYear()} />
    </div>
  );
}
