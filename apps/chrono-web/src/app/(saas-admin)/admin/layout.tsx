"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Building2,
  KeyRound,
  Users,
  ScrollText,
  CreditCard,
  TrendingUp,
  Mail,
  UserCog,
  ShieldCheck,
  LayoutDashboard,
  Megaphone,
  LineChart,
  SlidersHorizontal,
  Layers,
  Plug,
  Gauge,
  KeySquare,
  Webhook,
  Receipt,
  Flag,
  LifeBuoy,
  Activity,
  ListTodo,
  Contact,
} from "lucide-react";
import {
  CenteredMessage,
  SidebarLayout,
  type NavItem,
  UserMenu,
} from "agora/ui";
import { useSession } from "@/lib/auth-client";
import { adminApi } from "@/lib/admin-client";

type PlatformAdminMe = { platformRole: string | null; permissions: Record<string, string[]> };

const PlatformPermissionsContext = createContext<Record<string, string[]>>({});

/** The signed-in platform admin's resolved permission set (visibility only — see `Can`). */
export function usePlatformPermissions(): Record<string, string[]> {
  return useContext(PlatformPermissionsContext);
}

/**
 * Platform admin shell. Guards on the staff Better Auth session, then on
 * holding ANY platform role via a live `/rpc-admin/me` check (never trusted
 * from the session itself) — a "viewer" may enter and look, an "admin" can
 * also act; individual controls gate on the resolved permission set via `Can`.
 * Not tenant-scoped: never calls `getRequestTenant()` or reads a tenant
 * header, so this renders identically on any host.
 */
// The sidebar primitive only supports flat item/label/separator groups (no
// true nested tree — see `NavItem` in `agora/ui`), so a requested multi-level
// IA is approximated with labeled flat groups. Sub-items that reuse the
// Organizations list page's real query filters (Active/Trial/Suspended) link
// there with query params; sections with no real page behind them yet
// (Modules, "Pending" org status) are deliberately omitted rather than linked
// to nothing — add them here once their features ship.
const NAV: NavItem[] = [
  { type: "item", name: "Dashboard", href: "/", icon: LayoutDashboard },
  { type: "label", name: "Organizations" },
  { type: "item", name: "All organizations", href: "/organizations", icon: Building2 },
  { type: "item", name: "Users", href: "/organizations/members", icon: Users },
  { type: "label", name: "Customers" },
  { type: "item", name: "Global customers", href: "/global-customers", icon: Contact },
  { type: "label", name: "Billing" },
  { type: "item", name: "Billing", href: "/billing", icon: CreditCard },
  { type: "item", name: "Transactions", href: "/transactions", icon: Receipt },
  { type: "item", name: "Subscriptions", href: "/subscriptions", icon: CreditCard },
  { type: "item", name: "Plans", href: "/plans", icon: Layers },
  { type: "item", name: "Metrics", href: "/metrics", icon: TrendingUp },
  { type: "item", name: "Usage", href: "/usage", icon: Gauge },
  { type: "item", name: "Reports", href: "/reports", icon: LineChart },
  { type: "label", name: "Operations" },
  { type: "item", name: "Feature flags", href: "/feature-flags", icon: Flag },
  { type: "item", name: "Notifications", href: "/notifications", icon: Mail },
  { type: "item", name: "Announcements", href: "/announcements", icon: Megaphone },
  { type: "item", name: "Support", href: "/support", icon: LifeBuoy },
  { type: "item", name: "Audit log", href: "/audit", icon: ScrollText },
  { type: "item", name: "Job queue", href: "/jobs", icon: ListTodo },
  { type: "label", name: "System" },
  { type: "item", name: "System health", href: "/health", icon: Activity },
  { type: "item", name: "System settings", href: "/settings", icon: SlidersHorizontal },
  { type: "item", name: "Integrations", href: "/integrations", icon: Plug },
  { type: "item", name: "API keys", href: "/api-keys", icon: KeySquare },
  { type: "item", name: "Webhooks", href: "/webhooks", icon: Webhook },
  { type: "item", name: "Sign-in methods", href: "/auth-providers", icon: KeyRound },
  { type: "item", name: "Security", href: "/security", icon: ShieldCheck },
  { type: "label", name: "Staff" },
  { type: "item", name: "Administrators", href: "/staff", icon: Users },
  { type: "item", name: "Roles & permissions", href: "/roles", icon: ShieldCheck },
  { type: "item", name: "Custom roles", href: "/staff/roles", icon: ShieldCheck },
  { type: "item", name: "Impersonations", href: "/impersonations", icon: UserCog },
];

const TITLES: Record<string, string> = {
  "/admin": "Dashboard",
  "/admin/organizations": "Organizations",
  "/admin/settings": "System settings",
  "/admin/integrations": "Integrations",
  "/admin/api-keys": "API keys",
  "/admin/webhooks": "Webhooks",
  "/admin/auth-providers": "Sign-in methods",
  "/admin/security": "Security",
  "/admin/feature-flags": "Feature flags",
  "/admin/notifications": "Notifications",
  "/admin/announcements": "Announcements",
  "/admin/support": "Support",
  "/admin/staff": "Administrators",
  "/admin/roles": "Roles & permissions",
  "/admin/staff/roles": "Custom roles",
  "/admin/impersonations": "Impersonations",
  "/admin/organizations/members": "Users",
  "/admin/global-customers": "Global customers",
  "/admin/audit": "Audit log",
  "/admin/jobs": "Job queue",
  "/admin/health": "System health",
  "/admin/billing": "Billing",
  "/admin/transactions": "Transactions",
  "/admin/subscriptions": "Subscriptions",
  "/admin/plans": "Plans",
  "/admin/metrics": "Metrics",
  "/admin/usage": "Usage & limits",
  "/admin/reports": "Reports",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const pathname = usePathname();
  const [me, setMe] = useState<PlatformAdminMe | null>(null);

  useEffect(() => {
    if (!isPending && !session) window.location.href = "/login";
  }, [isPending, session]);

  useEffect(() => {
    if (isPending || !session) return;
    let cancelled = false;
    (async () => {
      const res = await adminApi["rpc-admin"].me.$get();
      const body = await res.json();
      if (!cancelled) setMe(body);
    })();
    return () => {
      cancelled = true;
    };
  }, [isPending, session]);

  useEffect(() => {
    if (me && !me.platformRole) window.location.href = "/dashboard";
  }, [me]);

  if (isPending || !session || !me?.platformRole) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  const nav = NAV.filter(
    (item) =>
      item.type !== "item" ||
      item.href !== "/impersonations" ||
      (me.permissions.impersonation ?? []).includes("force-end"),
  );

  return (
    <PlatformPermissionsContext.Provider value={me.permissions}>
      <SidebarLayout
        items={nav}
        basePath="/admin"
        sidebarTop={<span className="text-sm font-medium">Platform Admin</span>}
        sidebarBottom={
          <UserMenu name={session.user.name} email={session.user.email} />
        }
        breadcrumb={<span className="text-sm font-medium">{TITLES[pathname] ?? "Platform Admin"}</span>}
        defaultExpandAllGroups
      >
        {children}
      </SidebarLayout>
    </PlatformPermissionsContext.Provider>
  );
}
