"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Settings,
  Building2,
  Users,
  CalendarClock,
  Clock,
  Monitor,
  MonitorSmartphone,
  Wallet,
  Award,
  Ticket,
  Percent,
  Timer,
  Coins,
  ShieldAlert,
  ShoppingCart,
  BarChart3,
  MessageSquare,
  CreditCard,
  Scale,
} from "lucide-react";
import { Fragment } from "react";
import {
  cn,
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  SidebarLayout,
  TenantSwitcher,
  type NavItem,
  CenteredMessage,
  UserMenu,
  useRegisterUploadTarget,
} from "agora/ui";
import { WORKSPACE_SUSPENDED } from "agora";
import { useSession, useListOrganizations } from "@/lib/auth-client";
import { api } from "@/lib/rpc";
import { ImpersonationBanner } from "@/components/dashboard/impersonation-banner";
import { NotificationBell } from "@/components/dashboard/notification-bell";
import { DashboardMeProvider } from "@/lib/use-dashboard-me";
import type { UploadTarget } from "@/lib/upload";

// Default drop/paste target for the whole dashboard — any page that doesn't
// register its own override (e.g. Files registers `feature: "files"`) lands
// files here, tagged `general`.
const DEFAULT_UPLOAD_TARGET: UploadTarget = {
  kind: "tenant",
  feature: "general",
  visibility: "private",
};

// "Projects" is gated by the `modules.project` feature flag (see
// packages/agora/src/contracts/module-registry.ts) — a tenant with the
// module disabled never sees the nav entry. Registry default is `true`, so
// the entry stays visible until the fetch below says otherwise (no flash).
const BASE_NAV: NavItem[] = [
  { type: "label", name: "Overview" },
  { type: "item", name: "Dashboard", href: "/", icon: LayoutDashboard },

  { type: "label", name: "Business" },
  // "Projects" (agora scaffold example) hidden from the Chrono nav — kept,
  // not deleted; page and API routes are untouched, may be reused later.
  { type: "item", name: "Branches", href: "/branches", icon: Building2 },
  { type: "item", name: "Devices", href: "/devices", icon: MonitorSmartphone },

  // Branch-scoped, staff-facing floor operations (what a shift worker touches
  // day to day at a single branch) — grouped separately from Business/Money.
  { type: "label", name: "Daily Operations" },
  { type: "item", name: "Stations", href: "/stations", icon: Monitor },
  { type: "item", name: "Shifts", href: "/shifts", icon: Clock },
  { type: "item", name: "Sessions", href: "/sessions", icon: Timer },

  { type: "label", name: "Customers" },
  { type: "item", name: "Members", href: "/members", icon: Users },
  { type: "item", name: "Reservations", href: "/reservations", icon: CalendarClock },
  { type: "item", name: "Loyalty", href: "/loyalty", icon: Award },
  { type: "item", name: "Inquiries", href: "/inquiries", icon: MessageSquare },

  { type: "label", name: "Money" },
  { type: "item", name: "Wallets", href: "/wallets", icon: Wallet },
  { type: "item", name: "Payments", href: "/payments", icon: CreditCard },
  { type: "item", name: "Credits", href: "/credits", icon: Coins },
  { type: "item", name: "POS", href: "/pos", icon: ShoppingCart },
  { type: "item", name: "Vouchers", href: "/vouchers", icon: Ticket },
  { type: "item", name: "Promos", href: "/promos", icon: Percent },
  { type: "item", name: "Reconciliation", href: "/reconciliation", icon: Scale },

  { type: "label", name: "Security" },
  { type: "item", name: "Security Alerts", href: "/security-alerts", icon: ShieldAlert },
];

// Settings is pinned to the bottom of the sidebar — all business configuration
// now lives under this single hub, so it sits apart from the primary nav. The
// app version rides on the right edge of the row.
const BOTTOM_NAV: NavItem[] = [
  { type: "item", name: "Reports", href: "/reports", icon: BarChart3 },
  {
    type: "item",
    name: "Settings",
    href: "/settings",
    icon: Settings,
    trailing: (
      <span className="text-xs text-muted-foreground">
        v{process.env.NEXT_PUBLIC_APP_VERSION}
      </span>
    ),
  },
];

// Segment → breadcrumb/title label. Keys are full dashboard paths so the
// segment-derived breadcrumb can resolve each level of a nested settings path.
const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/reports": "Reports",
  "/dashboard/reports/sales": "Sales Report",
  "/dashboard/reports/wallet": "Wallet Activity",
  "/dashboard/branches": "Branches",
  "/dashboard/stations": "Stations",
  "/dashboard/devices": "Devices",
  "/dashboard/shifts": "Shifts",
  "/dashboard/sessions": "Sessions",
  "/dashboard/members": "Members",
  "/dashboard/reservations": "Reservations",
  "/dashboard/inquiries": "Inquiries",
  "/dashboard/wallets": "Wallets",
  "/dashboard/payments": "Payments",
  "/dashboard/credits": "Credits",
  "/dashboard/pos": "POS",
  "/dashboard/pos/products": "POS Products",
  "/dashboard/pos/history": "Sale History",
  "/dashboard/loyalty": "Loyalty",
  "/dashboard/vouchers": "Vouchers",
  "/dashboard/promos": "Promos",
  "/dashboard/reconciliation": "Reconciliation",
  "/dashboard/security-alerts": "Security Alerts",
  "/dashboard/files": "Files",
  "/dashboard/settings": "Settings",
  "/dashboard/settings/branding": "Branding",
  "/dashboard/settings/landing-page": "Landing page",
  "/dashboard/settings/crew": "Crew",
  "/dashboard/settings/roles": "Roles",
  "/dashboard/settings/domains": "Domains",
  "/dashboard/settings/api-keys": "API Keys",
  "/dashboard/settings/webhooks": "Webhooks",
  "/dashboard/settings/integrations": "Integrations",
  "/dashboard/settings/features": "Features",
  "/dashboard/settings/billing": "Billing",
  "/dashboard/settings/security": "Security",
  "/dashboard/settings/security/mfa": "Two-factor authentication",
  "/dashboard/settings/customers": "Customers",
  "/dashboard/settings/danger": "Danger zone",
  "/dashboard/settings/audit": "Audit Log",
};

function titleFor(path: string): string {
  const known = TITLES[path];
  if (known) return known;
  // Fallback: prettify the last segment (e.g. "api-keys" → "Api keys").
  const seg = path.split("/").filter(Boolean).pop() ?? "";
  return seg
    ? seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ")
    : "Dashboard";
}

// Build cumulative crumbs from the pathname segments after the /dashboard root.
function crumbsFor(pathname: string): { href: string; title: string }[] {
  const segments = pathname.split("/").filter(Boolean); // e.g. ["dashboard","settings","branding"]
  const crumbs: { href: string; title: string }[] = [];
  let acc = "";
  for (const segment of segments) {
    acc += `/${segment}`;
    crumbs.push({ href: acc, title: titleFor(acc) });
  }
  return crumbs;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  // Feeds the (data-free) TenantSwitcher in agora/ui.
  const { data: orgs } = useListOrganizations();
  const pathname = usePathname();
  const [projectsEnabled, setProjectsEnabled] = useState(true);

  useRegisterUploadTarget<UploadTarget>(DEFAULT_UPLOAD_TARGET);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const res = await api.rpc.modules.$get();
      if (cancelled || !res.ok) return;
      const { modules } = await res.json();
      const project = modules.find((m) => m.key === "project");
      if (project) setProjectsEnabled(project.enabled);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const NAV = projectsEnabled
    ? BASE_NAV
    : BASE_NAV.filter((item) => item.type !== "item" || item.href !== "/projects");

  useEffect(() => {
    if (!isPending && !session) window.location.href = "/login";
  }, [isPending, session]);

  // If the API reports the business as suspended (non-owner staff are blocked),
  // send the user to the suspended notice. Owners are allowed through so they can
  // resume from the Danger Zone, so they never hit this.
  useEffect(() => {
    if (isPending || !session) return;
    let cancelled = false;
    (async () => {
      const res = await api.rpc.me.$get();
      if (cancelled || res.ok) return;
      if ((res.status as number) === 403) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (body?.error === WORKSPACE_SUSPENDED) {
          window.location.href = "/suspended";
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPending, session]);

  if (isPending || !session) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  const crumbs = crumbsFor(pathname);

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={crumb.href}>
              {i > 0 ? <BreadcrumbSeparator className="hidden sm:inline-flex" /> : null}
              <BreadcrumbItem
                className={cn(isLast ? undefined : "hidden sm:inline-flex")}
              >
                {isLast ? (
                  <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={crumb.href}>{crumb.title}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <DashboardMeProvider>
      <SidebarLayout
        items={NAV}
        bottomItems={BOTTOM_NAV}
        basePath="/dashboard"
        sidebarTop={<TenantSwitcher organizations={orgs} />}
        sidebarBottom={
          <UserMenu name={session.user.name} email={session.user.email} />
        }
        breadcrumb={breadcrumb}
        headerEnd={<NotificationBell />}
      >
        <ImpersonationBanner />
        {children}
      </SidebarLayout>
    </DashboardMeProvider>
  );
}
