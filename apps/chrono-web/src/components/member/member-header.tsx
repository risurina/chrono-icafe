"use client";

import Link from "next/link";
import { SiteHeader, ThemeToggle, Row, BrandHeader, IdentityMenu } from "agora/ui";
import { memberAuth } from "@/lib/member-client";
import { MEMBER_USER_MENU_ITEMS } from "./member-nav.config";
import type { MemberUser } from "@/lib/member-client";

/**
 * The member area's own header — sticky/opaque (unlike the landing page's
 * fixed/transparent `TenantHeader`, which overlays a hero this surface
 * doesn't have). Deviation from the plan's "reuse TenantHeader with a
 * `surface` prop" note: kept as a small standalone component instead of
 * widening `TenantHeader`'s public props, to keep this phase's diff scoped.
 */
export function MemberHeader({
  tenantName,
  displayName,
  logoUrl,
  logoDarkUrl,
  member,
}: {
  tenantName: string;
  displayName?: string | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  member: MemberUser;
}) {
  return (
    <SiteHeader
      position="sticky"
      maxWidth="full"
      containerClassName="h-16"
      brand={
        <Link href="/member" aria-label={`${displayName ?? tenantName} home`}>
          {logoUrl || logoDarkUrl ? (
            <BrandHeader
              compact
              displayName={displayName}
              logoUrl={logoUrl}
              logoDarkUrl={logoDarkUrl}
              fallback={tenantName}
            />
          ) : (
            <span className="block max-w-[11rem] truncate font-chrono text-base font-black uppercase tracking-tight text-primary sm:text-xl">
              {displayName ?? tenantName}
            </span>
          )}
        </Link>
      }
      actions={
        <Row items="center" gap={2}>
          <Row className="hidden sm:flex">
            <ThemeToggle />
          </Row>
          <IdentityMenu
            name={member.name}
            email={member.email}
            items={MEMBER_USER_MENU_ITEMS.map((item) => ({
              label: item.label,
              href: item.href,
              icon: item.icon,
            }))}
            triggerTestId="member-user-menu-trigger"
            onSignOut={async () => {
              await memberAuth.signOut();
              location.href = "/login";
            }}
          />
        </Row>
      }
    />
  );
}
