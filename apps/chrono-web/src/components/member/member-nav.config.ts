import {
  LayoutDashboard,
  CalendarClock,
  Ticket,
  Wallet,
  History,
  UserCircle,
  Settings,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

/**
 * The member-area tab registry — data, not JSX, so a future app can flag a
 * different set of tabs without touching `member-nav.tsx`/`member-shell.tsx`.
 *
 * member-portal-v2 phase 1 (nav consolidation): Session absorbed Connect's
 * QR-scan explainer (folded directly into `/member/session`'s page content —
 * `/member/connect` now just redirects there); History absorbed Promos as a
 * "reachable from within it" link tab (`/member/promos` keeps its own page,
 * it's just no longer a separate top-level nav entry); the dead, page-less
 * Leaderboard entry is removed entirely (was `disabled` — no near-term plan
 * to build it).
 *
 * The `promos` entry below is intentionally kept in this array with
 * `placements: []` — invisible in every nav surface, but still present so
 * `matchMemberNav` keeps highlighting `/member/promos*` consistently. A
 * pending member's access to Promos (and every other route) is no longer
 * blocked client-side — see `member-gate.tsx`'s `MemberAccessBanner`, which
 * replaced the old per-route `requiresApproval`/`ApprovalRequiredCard`
 * mechanism with a persistent banner instead.
 */
export type MemberNavEntry = {
  key: string;
  label: string;
  shortLabel: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** Exact-match highlighting instead of prefix match (only the dashboard root needs this). */
  exact?: boolean;
  /** Where this entry renders: the desktop tab bar, the mobile bottom bar, and/or the user menu. */
  placements: ReadonlyArray<"tabs" | "bottomNav" | "menu">;
};

export const MEMBER_NAV: MemberNavEntry[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    shortLabel: "Home",
    href: "/member",
    icon: LayoutDashboard,
    exact: true,
    placements: ["tabs", "bottomNav"],
  },
  {
    key: "session",
    label: "Session",
    shortLabel: "Session",
    href: "/member/session",
    icon: History,
    placements: ["tabs", "bottomNav"],
  },
  {
    key: "reservations",
    label: "Reservations",
    shortLabel: "Book",
    href: "/member/reservations",
    icon: CalendarClock,
    placements: ["tabs", "bottomNav"],
  },
  {
    key: "promos",
    label: "Promos",
    shortLabel: "Promos",
    href: "/member/promos",
    icon: Ticket,
    // Merged into History (phase 1) — kept unplaced (invisible in every nav
    // surface); reachable via the History page's Promos tab.
    placements: [],
  },
  {
    key: "wallet",
    label: "Wallet",
    shortLabel: "Wallet",
    href: "/member/wallet",
    icon: Wallet,
    placements: ["tabs", "menu"],
  },
  {
    key: "history",
    label: "History",
    shortLabel: "History",
    href: "/member/history",
    icon: History,
    placements: ["tabs", "menu"],
  },
  {
    key: "profile",
    label: "Profile",
    shortLabel: "Profile",
    href: "/member/profile",
    icon: UserCircle,
    placements: ["tabs", "menu"],
  },
  {
    key: "settings",
    label: "Settings",
    shortLabel: "Settings",
    href: "/member/settings",
    icon: Settings,
    placements: ["tabs", "menu"],
  },
  {
    key: "inquiries",
    label: "Help",
    shortLabel: "Help",
    href: "/member/inquiries",
    icon: MessageSquare,
    placements: ["menu"],
  },
];

/** Prefix matching (fixes the reference's bug where a detail route like
 * `/member/promos/[id]` highlighted nothing) — the dashboard root uses `exact`
 * so every other tab's prefix doesn't also match `/member`. */
export function matchMemberNav(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const MEMBER_TAB_ITEMS = MEMBER_NAV.filter((item) => item.placements.includes("tabs"));
export const MEMBER_BOTTOM_NAV_ITEMS = MEMBER_NAV.filter((item) =>
  item.placements.includes("bottomNav"),
);
export const MEMBER_USER_MENU_ITEMS = MEMBER_NAV.filter((item) =>
  item.placements.includes("menu"),
);

/** Dashboard card order — configuration, not layout logic, per the plan. */
export const MEMBER_DASHBOARD_CARDS = [
  "playtime",
  "activeReservation",
  "membershipStatus",
  "wallet",
  "membership",
  "premiumStore",
] as const;
