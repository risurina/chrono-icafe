"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Button, ThemeToggle, CenteredMessage, Row } from "agora/ui";
import { memberAuth, useMemberSession } from "@/lib/member-client";

const PUBLIC = ["/portal/login", "/portal/sign-up", "/portal/forgot", "/portal/reset"];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC.includes(pathname);
  const { member, isPending } = useMemberSession();

  useEffect(() => {
    if (!isPublic && !isPending && !member) location.href = "/portal/login";
  }, [isPublic, isPending, member]);

  // Auth pages render without the guard or chrome.
  if (isPublic) return <>{children}</>;

  if (isPending || !member) {
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
