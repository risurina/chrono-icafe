"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, LogOut, User } from "lucide-react";
import { Avatar, Button, Stack, Row } from "agora/ui";
import { cn } from "agora/ui/cn";
import { customerAuth } from "@/lib/customer-client";

/**
 * The apex global-identity area's own nav rail — Dashboard/Profile/Logout,
 * matching the reference screenshot's left rail. Deliberately NOT the
 * tenant-side `member-nav.tsx` (many items, tenant-scoped data): this is a
 * much smaller, apex-only nav for the "Gaming Lounge Directory" page, built
 * fresh from `agora/ui` primitives only.
 */
const NAV_ITEMS = [
  { label: "Dashboard", href: "/member", icon: LayoutDashboard },
  { label: "Profile", href: "/member/profile", icon: User },
] as const;

export function GlobalPortalSidebar({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}) {
  const pathname = usePathname();

  return (
    // `min-h-[calc(100vh-112px)]` matches the content column's own min-height
    // (`global-portal-layout.tsx`): 80px `MarketingHeader` + 32px row top
    // padding (`py-8`), so the border-r spans the full column height instead
    // of stopping at the nav's own content height. Keep both in sync.
    <Stack
      gap={6}
      className="min-h-[calc(100vh-112px)] w-full border-border/60 sm:sticky sm:top-24 sm:w-56 sm:border-r sm:pr-6"
    >
      <Row items="center" gap={3}>
        <Avatar name={name} size="lg" />
        <Stack gap={0} className="min-w-0 flex flex-col">
          <span className="truncate text-sm font-medium">{name ?? "—"}</span>
          <span className="truncate text-xs text-muted-foreground">{email ?? "—"}</span>
        </Stack>
      </Row>

      <Stack gap={1}>
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          );
        })}
        <Button
          variant="ghost"
          className="justify-start gap-2 px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={async () => {
            await customerAuth.signOut();
            location.href = "/member/login";
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Logout
        </Button>
      </Stack>
    </Stack>
  );
}
