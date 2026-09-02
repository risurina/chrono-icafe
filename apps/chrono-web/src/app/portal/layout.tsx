"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Button,
  ThemeToggle,
  CenteredMessage,
  Row,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  toast,
} from "agora/ui";
import { memberAuth, useMemberSession } from "@/lib/member-client";
import { applyForTenantMembership, useGlobalCustomerSession } from "@/lib/customer-client";

const PUBLIC = ["/portal/login", "/portal/sign-up", "/portal/forgot", "/portal/reset"];

/**
 * Shown instead of redirecting to /portal/login when a signed-in GLOBAL
 * customer (agora/customer-auth) has not yet applied to become a customer of
 * this tenant — distinct from "not authenticated at all". Applying creates
 * the linked `tenantMember` row and reloads so `useMemberSession()` resolves
 * via the session bridge (see .ai/plans/agora/active/global-customers).
 */
function ApplyForTenantPrompt() {
  const [applying, setApplying] = useState(false);

  async function onApply() {
    setApplying(true);
    const { error } = await applyForTenantMembership();
    if (error) {
      toast.error(error);
      setApplying(false);
      return;
    }
    location.reload();
  }

  return (
    <CenteredMessage>
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Join this business</CardTitle>
          <CardDescription>
            You&apos;re signed in with your account — apply to become a customer
            of this business to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onApply} disabled={applying} className="w-full">
            {applying ? "Applying…" : "Apply"}
          </Button>
        </CardContent>
      </Card>
    </CenteredMessage>
  );
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC.includes(pathname);
  const { member, isPending } = useMemberSession();
  const { customer: globalCustomer, isPending: globalPending } = useGlobalCustomerSession();

  const bothResolved = !isPending && !globalPending;
  const canApply = bothResolved && !member && !!globalCustomer;

  useEffect(() => {
    if (!isPublic && bothResolved && !member && !globalCustomer) {
      location.href = "/portal/login";
    }
  }, [isPublic, bothResolved, member, globalCustomer]);

  // Auth pages render without the guard or chrome.
  if (isPublic) return <>{children}</>;

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
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b px-6">
        <span className="text-sm font-medium">Member area</span>
        <Row items="center" gap={1}>
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await memberAuth.signOut();
              location.href = "/portal/login";
            }}
          >
            Sign out
          </Button>
        </Row>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
