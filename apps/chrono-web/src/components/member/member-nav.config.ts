import {
  LayoutDashboard,
  CalendarClock,
  QrCode,
  Ticket,
  Wallet,
  History,
  Trophy,
  UserCircle,
  Settings,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

/**
 * The member-area tab registry — data, not JSX, so a future app can flag a
 * different set of tabs without touching `member-nav.tsx`/`member-shell.tsx`.
 * Mirrors the reference's 10-tab bar (Leaderboard stays disabled, no page).
 */
export type MemberNavEntry = {
  key: string;
  label: string;
  shortLabel: string;
  href: string;
  icon: LucideIcon;
  /** Gated by `RouteGate` — only Promos is flagged per the plan's decision. */
  requiresApproval?: boolean;
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
    key: "connect",
    label: "Connect",
    shortLabel: "Connect",
    href: "/member/connect",
    icon: QrCode,
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
    requiresApproval: true,
    placements: ["tabs", "bottomNav"],
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
    key: "leaderboard",
    label: "Leaderboard",
    shortLabel: "Ranks",
    href: "/member/leaderboard",
    icon: Trophy,
    disabled: true,
    placements: ["tabs"],
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
