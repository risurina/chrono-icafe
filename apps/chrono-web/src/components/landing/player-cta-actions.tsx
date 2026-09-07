"use client";

import Link from "next/link";
import { useMemberSession, useGlobalCustomerSession } from "agora/client/react";
import { Row, buttonVariants } from "agora/ui";
import { cn } from "agora/ui/cn";
import { ApplyForTenantPrompt } from "@/components/member/apply-for-tenant-prompt";

const PILL = "h-12 rounded-full px-8 text-xs font-black uppercase tracking-widest";

/**
 * The landing page's join / sign-in actions, branched on who is looking.
 *
 * This deliberately does NOT reuse `MemberGate`: that component hard-redirects
 * an anonymous visitor to `/login`, which on a public marketing page would
 * bounce every visitor this page exists to convert. It calls the same two
 * session hooks directly instead, and never redirects.
 *
 * While either session is still resolving it renders the ANONYMOUS branch, not
 * a spinner — the anonymous links are correct for the large majority of
 * visitors, they work regardless of session, and a marketing page must not
 * flash a loading state above the fold.
 *
 * `ApplyForTenantPrompt` is reused verbatim; its copy is asserted by
 * `e2e/tests/global-customers/apply-for-tenant.spec.ts`, which drives `/portal`
 * rather than this page, so the second render site adds no locator ambiguity.
 */
export function PlayerCtaActions({ tenantName }: { tenantName: string }) {
  const { member, isPending } = useMemberSession();
  const { customer, isPending: globalPending } = useGlobalCustomerSession();
  const resolved = !isPending && !globalPending;

  // Already a member of THIS tenant.
  if (resolved && member) {
    return (
      <Row wrap gap={4} justify="center">
        <Link
          href="/member"
          className={cn(buttonVariants(), PILL, "shadow-lg shadow-primary/20")}
          data-testid="landing-playercta-continue"
        >
          Continue to your account
        </Link>
      </Row>
    );
  }

  // Signed in globally, but not yet a member here — the one-click apply flow.
  if (resolved && customer) {
    return <ApplyForTenantPrompt />;
  }

  return (
    <Row wrap gap={4} justify="center">
      <Link
        href="/member/sign-up"
        className={cn(buttonVariants(), PILL, "shadow-lg shadow-primary/20")}
        data-testid="landing-playercta-join"
      >
        {`Join ${tenantName}`}
      </Link>
      <Link
        href="/login"
        className={cn(buttonVariants({ variant: "outline" }), PILL)}
        data-testid="landing-playercta-signin"
      >
        Already a member? Sign in
      </Link>
    </Row>
  );
}
