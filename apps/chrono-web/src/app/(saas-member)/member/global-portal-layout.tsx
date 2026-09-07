"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Button, ThemeToggle, CenteredMessage, Row } from "agora/ui";
import { customerAuth, useGlobalCustomerSession } from "@/lib/customer-client";

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
      <header className="flex h-14 items-center justify-between border-b px-6">
        <span className="text-sm font-medium">Your account</span>
        <Row items="center" gap={1}>
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await customerAuth.signOut();
              location.href = "/member/login";
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
