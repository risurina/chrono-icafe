"use client";

import { ThemeToggle, Row, IdentityMenu } from "agora/ui";
import { TenantHeader } from "@/components/landing/marketing-chrome";
import { memberAuth } from "@/lib/member-client";
import { MEMBER_USER_MENU_ITEMS } from "./member-nav.config";
import type { MemberUser } from "@/lib/member-client";

/**
 * The member area's header — `TenantHeader` (the exact same fixed,
 * transparent-until-scroll header the tenant's public landing/auth pages use)
 * with its default Staff/Member-login CTA replaced by the signed-in member's
 * own identity menu. `MemberNav`'s tab bar renders as its own row below this
 * one (see `member-gate.tsx`'s `Chrome`).
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
    <TenantHeader
      tenantName={tenantName}
      displayName={displayName}
      logoUrl={logoUrl}
      logoDarkUrl={logoDarkUrl}
      actions={
        <Row items="center" gap={2}>
          <Row className="sm:flex">
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
