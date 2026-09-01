"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Stack,
  Row,
  StatTile,
  Sparkline,
  ListRow,
  ListRows,
  buttonVariants,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformMetricsOverview,
  PlatformBillingSummary,
  PlatformOrgSummary,
  PlatformTenantUsageRow,
  PlatformAuditEvent,
} from "agora";

type FetchState = "loading" | "ok" | "error";

/**
 * Platform admin landing page — an expanded KPI/chart/activity dashboard
 * composed from existing routes (`metrics/overview` — extended,
 * `billing/summary`, `metrics/tenants`, `audit`, `organizations`). Each
 * section tracks its own fetch state independently, so one failing fetch
 * (network/5xx — both code-defined platform roles hold every permission
 * this page's fetches use) degrades only that section, never the whole
 * page. See `.ai/plans/active/admin-dashboard-expansion/README.md`.
 */
export default function PlatformAdminDashboardPage() {
  const [overview, setOverview] = useState<PlatformMetricsOverview | null>(null);
  const [overviewState, setOverviewState] = useState<FetchState>("loading");

  const [billing, setBilling] = useState<PlatformBillingSummary | null>(null);
  const [billingState, setBillingState] = useState<FetchState>("loading");

  const [recentOrgs, setRecentOrgs] = useState<PlatformTenantUsageRow[]>([]);
  const [recentOrgsState, setRecentOrgsState] = useState<FetchState>("loading");

  const [recentActivity, setRecentActivity] = useState<PlatformAuditEvent[]>([]);
  const [recentActivityState, setRecentActivityState] = useState<FetchState>("loading");

  const [pastDueOrgs, setPastDueOrgs] = useState<PlatformOrgSummary[]>([]);
  const [pastDueOrgsState, setPastDueOrgsState] = useState<FetchState>("loading");

  const load = useCallback(async () => {
    setOverviewState("loading");
    setBillingState("loading");
    setRecentOrgsState("loading");
    setRecentActivityState("loading");
    setPastDueOrgsState("loading");

    const [overviewRes, billingRes, recentOrgsRes, recentActivityRes, pastDueRes] =
      await Promise.all([
        adminApi["rpc-admin"].metrics.overview.$get().catch(() => null),
        adminApi["rpc-admin"].billing.summary.$get().catch(() => null),
        adminApi["rpc-admin"].metrics.tenants
          .$get({
            query: { page: "1", pageSize: "5", sort: "createdAt", order: "desc" },
          })
          .catch(() => null),
        adminApi["rpc-admin"].audit
          .$get({ query: { page: "1", pageSize: "5" } })
          .catch(() => null),
        adminApi["rpc-admin"].organizations
          .$get({ query: { page: "1", pageSize: "5", subscriptionStatus: "past_due" } })
          .catch(() => null),
      ]);

    if (overviewRes?.ok) {
      setOverview((await overviewRes.json()) as PlatformMetricsOverview);
      setOverviewState("ok");
    } else {
      setOverviewState("error");
    }

    if (billingRes?.ok) {
      setBilling((await billingRes.json()) as PlatformBillingSummary);
      setBillingState("ok");
    } else {
      setBillingState("error");
    }

    if (recentOrgsRes?.ok) {
      const body = await recentOrgsRes.json();
      setRecentOrgs(body.items as PlatformTenantUsageRow[]);
      setRecentOrgsState("ok");
    } else {
      setRecentOrgsState("error");
    }

    if (recentActivityRes?.ok) {
      const body = await recentActivityRes.json();
      setRecentActivity(body.items as PlatformAuditEvent[]);
      setRecentActivityState("ok");
    } else {
      setRecentActivityState("error");
    }

    if (pastDueRes?.ok) {
      const body = await pastDueRes.json();
      setPastDueOrgs(body.items as PlatformOrgSummary[]);
      setPastDueOrgsState("ok");
    } else {
      setPastDueOrgsState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeSubscriptions =
    billingState === "ok" && billing && billing.enabled
      ? billing.counts
          .filter((c) => c.status === "active")
          .reduce((sum, c) => sum + c.tenantCount, 0)
      : null;

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide health at a glance.
        </p>
      </div>

      <Row gap={3} wrap>
        <StatTile
          label="Total tenants"
          value={overview?.totalTenants}
          state={overviewState}
          href="/admin/organizations"
        />
        <StatTile
          label="Active tenants"
          value={overview?.activeTenants}
          state={overviewState}
          href="/admin/organizations?status=active"
        />
        <StatTile
          label="Trial tenants"
          value={overview?.trialTenants}
          state={overviewState}
          href="/admin/organizations?subscriptionStatus=trialing"
        />
        <StatTile
          label="Suspended tenants"
          value={overview?.suspendedTenants}
          state={overviewState}
          href="/admin/organizations?status=suspended"
        />
        <StatTile
          label="New tenants this month"
          value={overview?.newTenantsThisMonth}
          state={overviewState}
        />
        <StatTile
          label="Total users"
          value={overview?.totalUsers}
          state={overviewState}
        />
        <StatTile
          label="Users in active tenants"
          value={overview?.usersInActiveTenants}
          state={overviewState}
        />
        <StatTile
          label="Active subscriptions"
          value={activeSubscriptions ?? undefined}
          state={
            billingState !== "ok"
              ? billingState
              : activeSubscriptions === null
                ? "unavailable"
                : "ok"
          }
          unavailableReason={
            billingState === "ok" ? "billing is not configured" : undefined
          }
          href="/admin/billing"
        />
        <StatTile
          label="Tenants past due"
          value={overview?.pastDueTenantCount}
          state={overviewState}
          href="/admin/organizations?subscriptionStatus=past_due"
        />
      </Row>

      <Row gap={3} wrap>
        <StatTile
          label="Storage usage"
          state="unavailable"
          unavailableReason="pending usage metering (plan #8)"
        />
        <StatTile
          label="API usage"
          state="unavailable"
          unavailableReason="pending usage metering (plan #8)"
        />
        <StatTile
          label="System health"
          state="unavailable"
          unavailableReason="no health-check registry exists yet"
        />
        <StatTile
          label="Est. MRR"
          value={
            overview?.estMrr !== null && overview?.estMrr !== undefined
              ? `$${overview.estMrr.toLocaleString()}`
              : undefined
          }
          state={
            overviewState === "ok" && overview?.estMrr === null
              ? "unavailable"
              : overviewState
          }
          unavailableReason="pending #5-#7"
        />
      </Row>

      <Row gap={4} wrap>
        <Card className="min-w-[260px] flex-1">
          <CardHeader>
            <CardTitle>Tenant growth</CardTitle>
            <CardDescription>New tenants per day, last 90 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline
              data={(overview?.signups ?? []).map((b) => ({
                date: b.date,
                value: b.count,
              }))}
            />
          </CardContent>
        </Card>
        <Card className="min-w-[260px] flex-1">
          <CardHeader>
            <CardTitle>User growth</CardTitle>
            <CardDescription>Distinct new users per day.</CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline
              data={(overview?.userGrowthPerDay ?? []).map((b) => ({
                date: b.date,
                value: b.count,
              }))}
            />
          </CardContent>
        </Card>
        <Card className="min-w-[260px] flex-1">
          <CardHeader>
            <CardTitle>New memberships</CardTitle>
            <CardDescription>
              Distinct users joining a tenant per day. Not the same as user growth — one
              user joining two tenants on two different days counts twice.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline
              data={(overview?.newMembershipsPerDay ?? []).map((b) => ({
                date: b.date,
                value: b.count,
              }))}
            />
          </CardContent>
        </Card>
        <Card className="min-w-[260px] flex-1">
          <CardHeader>
            <CardTitle>Subscription growth</CardTitle>
            <CardDescription>Activations per day, last 90 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline
              data={(overview?.subscriptionGrowth ?? []).map((b) => ({
                date: b.date,
                value: b.count,
              }))}
            />
          </CardContent>
        </Card>
        <Card className="min-w-[260px] flex-1">
          <CardHeader>
            <CardTitle>Tenant activity</CardTitle>
            <CardDescription>Platform-admin actions per UTC day.</CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline
              data={(overview?.tenantActivityPerDay ?? []).map((b) => ({
                date: b.date,
                value: b.count,
              }))}
            />
          </CardContent>
        </Card>
        <Card className="min-w-[260px] flex-1">
          <CardHeader>
            <CardTitle>Est. revenue growth</CardTitle>
            <CardDescription>Estimated revenue added per day.</CardDescription>
          </CardHeader>
          <CardContent>
            {overviewState === "ok" &&
            (overview?.estRevenueGrowth?.length === 0 || overview?.estMrr === null) ? (
              <div className="flex h-[48px] items-center text-sm text-muted-foreground">
                Not available yet — pending #5-#7
              </div>
            ) : (
              <Sparkline
                data={(overview?.estRevenueGrowth ?? []).map((b) => ({
                  date: b.date,
                  value: b.count,
                }))}
              />
            )}
          </CardContent>
        </Card>
      </Row>

      <Row gap={4} wrap>
        <Card className="min-w-[300px] flex-1">
          <CardHeader>
            <CardTitle>Recent tenant registrations</CardTitle>
          </CardHeader>
          <CardContent>
            {recentOrgsState === "error" ? (
              <p className="text-sm text-muted-foreground">Couldn&apos;t load this.</p>
            ) : recentOrgsState === "ok" && recentOrgs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tenants yet.</p>
            ) : (
              <ListRows>
                {recentOrgs.map((org) => (
                  <ListRow key={org.tenantId}>
                    <Link
                      href={`/admin/organizations/${org.tenantId}`}
                      className="font-medium hover:underline"
                    >
                      {org.tenantName}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {org.tenantSlug} · {new Date(org.createdAt).toLocaleDateString()}
                    </p>
                  </ListRow>
                ))}
              </ListRows>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-[300px] flex-1">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              Every platform-admin action, most recent first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentActivityState === "error" ? (
              <p className="text-sm text-muted-foreground">Couldn&apos;t load this.</p>
            ) : recentActivityState === "ok" && recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <ListRows>
                {recentActivity.map((event) => (
                  <ListRow key={event.id}>
                    <span className="font-medium">{event.action}</span>
                    <p className="text-sm text-muted-foreground">
                      {event.actorLabel ?? "System"} ·{" "}
                      {new Date(event.createdAt).toLocaleString()}
                    </p>
                  </ListRow>
                ))}
              </ListRows>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-[300px] flex-1">
          <CardHeader>
            <CardTitle>Tenants past due</CardTitle>
          </CardHeader>
          <CardContent>
            {pastDueOrgsState === "error" ? (
              <p className="text-sm text-muted-foreground">Couldn&apos;t load this.</p>
            ) : pastDueOrgsState === "ok" && pastDueOrgs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tenants past due.</p>
            ) : (
              <ListRows>
                {pastDueOrgs.map((org) => (
                  <ListRow key={org.id}>
                    <Link
                      href={`/admin/organizations/${org.id}`}
                      className="font-medium hover:underline"
                    >
                      {org.name}
                    </Link>
                    <p className="text-sm text-muted-foreground">{org.slug}</p>
                  </ListRow>
                ))}
              </ListRows>
            )}
          </CardContent>
        </Card>
      </Row>

      <Row gap={4} wrap>
        <Card className="min-w-[300px] flex-1">
          <CardHeader>
            <CardTitle>System alerts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Pending — arrives with plan #17 Observability / health
            </p>
          </CardContent>
        </Card>
        <Card className="min-w-[300px] flex-1">
          <CardHeader>
            <CardTitle>Support tickets</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Pending — arrives with plan #10 Support tickets
            </p>
          </CardContent>
        </Card>
      </Row>

      <Card>
        <CardHeader>
          <CardTitle>Quick actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Row gap={2} wrap>
            <Link
              href="/admin/announcements/new"
              className={buttonVariants({ variant: "outline" })}
            >
              Send announcement
            </Link>
            <Link
              href="/admin/organizations"
              className={buttonVariants({ variant: "outline" })}
            >
              View organizations
            </Link>
            <Link
              href="/admin/audit"
              className={buttonVariants({ variant: "outline" })}
            >
              View audit log
            </Link>
            <Link
              href="/admin/billing"
              className={buttonVariants({ variant: "outline" })}
            >
              View billing
            </Link>
            <button
              disabled
              className={buttonVariants({ variant: "outline" })}
              title="no self-serve provisioning flow"
            >
              Create Tenant
            </button>
            <button
              disabled
              className={buttonVariants({ variant: "outline" })}
              title="pending platform user management"
            >
              Create User
            </button>
          </Row>
        </CardContent>
      </Card>

      <Card className="mt-8 bg-muted/20 border-muted">
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground font-medium mb-2">
            Pending dashboard features
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm text-muted-foreground">
            <div className="flex justify-between">
              <span>Failed payments</span>
              <span className="opacity-70">Blocked on #7 Payments/dunning</span>
            </div>
            <div className="flex justify-between">
              <span>True billed MRR</span>
              <span className="opacity-70">Blocked on #5/#6/#7</span>
            </div>
            <div className="flex justify-between">
              <span>True revenue growth</span>
              <span className="opacity-70">Blocked on #5/#6/#7</span>
            </div>
            <div className="flex justify-between">
              <span>Storage usage</span>
              <span className="opacity-70">Blocked on #8 Usage metering</span>
            </div>
            <div className="flex justify-between">
              <span>API usage</span>
              <span className="opacity-70">Blocked on #8 Usage metering</span>
            </div>
            <div className="flex justify-between">
              <span>System alerts</span>
              <span className="opacity-70">Blocked on #17 Observability / health</span>
            </div>
            <div className="flex justify-between">
              <span>Support tickets</span>
              <span className="opacity-70">Blocked on #10 Support tickets</span>
            </div>
            <div className="flex justify-between">
              <span>Create User</span>
              <span className="opacity-70">Blocked on user management</span>
            </div>
            <div className="flex justify-between">
              <span>Create Tenant</span>
              <span className="opacity-70">No self-serve provisioning</span>
            </div>
            <div className="flex justify-between">
              <span>Create Plan</span>
              <span className="opacity-70">Config-defined, not a DB entity</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}
