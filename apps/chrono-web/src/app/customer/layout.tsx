"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Button, ThemeToggle, CenteredMessage, Row } from "agora/ui";
import { customerAuth, useGlobalCustomerSession } from "@/lib/customer-client";

const PUBLIC = ["/customer/login", "/customer/sign-up", "/customer/forgot", "/customer/reset"];

/** Shell for the global customer identity's own apex-level pages. */
export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC.includes(pathname);
  const { customer, isPending } = useGlobalCustomerSession();

  useEffect(() => {
    if (!isPublic && !isPending && !customer) location.href = "/customer/login";
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
              location.href = "/customer/login";
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
