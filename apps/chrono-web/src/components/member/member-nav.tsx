"use client";

import { usePathname } from "next/navigation";
import { NavTabs, BottomNav, type NavTabItem } from "agora/ui";
import { MEMBER_TAB_ITEMS, MEMBER_BOTTOM_NAV_ITEMS, matchMemberNav } from "./member-nav.config";

function toNavItems(pathname: string): NavTabItem[] {
  return MEMBER_TAB_ITEMS.map((item) => ({
    href: item.href,
    label: item.label,
    icon: item.icon,
    active: matchMemberNav(pathname, item.href, item.exact),
    disabled: item.disabled,
    testId: `member-nav-${item.key}`,
  }));
}

/** Desktop tab bar — sticky under the header, horizontal-scroll for however
 * many items are placed in `tabs` (7 since member-portal-v2 phase 1's nav
 * consolidation). `top-20` matches `TenantHeader`'s fixed 80px height (the
 * header is out of document flow, so this bar's own sticky offset is what
 * keeps it flush underneath rather than document flow doing it for free). */
export function MemberNav() {
  const pathname = usePathname();
  return (
    <div className="flex sticky top-20 z-30 overflow-x-auto bg-background">
      <NavTabs items={toNavItems(pathname)} className="flex flex-1 justify-center min-w-max px-4" />
    </div>
  );
}

/** Mobile bottom bar — shortlabel items placed in `bottomNav` (3 since
 * member-portal-v2 phase 1's nav consolidation), `< md`. */
export function MemberBottomNav() {
  const pathname = usePathname();
  const items: NavTabItem[] = MEMBER_BOTTOM_NAV_ITEMS.map((item) => ({
    href: item.href,
    label: item.shortLabel,
    icon: item.icon,
    active: matchMemberNav(pathname, item.href, item.exact),
    disabled: item.disabled,
    testId: `member-bottom-nav-${item.key}`,
  }));
  return <BottomNav items={items} className="md:hidden" />;
}
