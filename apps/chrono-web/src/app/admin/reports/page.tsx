"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Stack,
  Row,
  DataTable,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  TrendChart,
  type DataTableColumn,
  type TrendChartSeries,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformReportsResponse,
  TenantGrowthBucket,
  PlanChangeBucket,
  ChurnBucket,
  ReportRange,
  ReportGranularity,
  UserGrowthBucket,
  SubscriptionGrowthBucket,
  TrialConversionBucket,
  EstRevenueBucket,
  FeatureAdoptionBucket,
  PlanIdDTO,
} from "agora";

/**
 * Tenant growth / plan changes / churn over 6-12 month windows — distinct
 * from `/admin/metrics` (current-state counts + a fixed 90-day series).
 * Reporting-only (no mutating action), gated on the existing
 * `organization:read` platform permission. No charting library in the repo,
 * so every series renders as a table (see the plan's Risks — chart is a
 * documented follow-up).
 */
export default function PlatformReportsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = searchParams.get("range") as ReportRange | null;
  const granularity = (searchParams.get("granularity") as ReportGranularity) || "month";
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const tenantId = searchParams.get("tenantId") || undefined;
  const planId = searchParams.get("planId") as PlanIdDTO | undefined;
  const compare = searchParams.get("compare") as
    "day" | "week" | "month" | "year" | undefined;

  // Derive resolved range for display. If from/to are set, range shouldn't be overridden but we handle it.

  const [data, setData] = useState<PlatformReportsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }

      // Mutual exclusion for custom date range vs preset
      if (key === "range" && value) {
        params.delete("from");
        params.delete("to");
      }
      if ((key === "from" || key === "to") && value) {
        params.delete("range");
      }

      router.replace(`/admin/reports?${params.toString()}`);
    },
    [router, searchParams],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const res = await adminApi["rpc-admin"].reports.$get({
      query: {
        range: range || undefined,
        granularity,
        from,
        to,
        tenantId,
        planId,
        compare,
      },
    });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      setData((await res.json()) as PlatformReportsResponse);
    }
  }, [range, granularity, from, to, tenantId, planId, compare]);

  useEffect(() => {
    load();
  }, [load]);

  // Download via the typed cross-origin admin client (the API is on a separate
  // host, so a bare relative URL would 404 against the web origin). Filename is
  // set client-side, matching the audit export.
  const handleExport = useCallback(async () => {
    const res = await adminApi["rpc-admin"].reports.export.$get({
      query: {
        range: range || undefined,
        granularity,
        from,
        to,
        tenantId,
        planId,
        compare,
      },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const link = document.createElement("a");
    link.href = url;
    link.download = `platform-reports-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [range, granularity, from, to, tenantId, planId, compare]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Reports are available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const renderComparison = (key: string) => {
    if (!compare || !data?.comparison || !data.comparison[key]) return null;
    const comp = data.comparison[key]!;
    const pct = comp.deltaPct !== null ? (comp.deltaPct * 100).toFixed(1) + "%" : "N/A";
    const sign = comp.deltaPct !== null && comp.deltaPct > 0 ? "+" : "";
    return (
      <span className="ml-2 text-sm text-muted-foreground">
        ({sign}
        {pct} vs prev {compare})
      </span>
    );
  };

  const growthColumns: DataTableColumn<TenantGrowthBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    {
      key: "newTenants",
      header: "New tenants",
      render: (b) => <span className="tabular-nums">{b.newTenants}</span>,
    },
    {
      key: "cumulativeTenants",
      header: "Cumulative",
      render: (b) => <span className="tabular-nums">{b.cumulativeTenants}</span>,
    },
  ];

  const planChangeColumns: DataTableColumn<PlanChangeBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    { key: "plan", header: "Plan", render: (b) => b.plan },
    {
      key: "count",
      header: "Changes",
      render: (b) => <span className="tabular-nums">{b.count}</span>,
    },
  ];

  const churnColumns: DataTableColumn<ChurnBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    {
      key: "churnedTenants",
      header: "Churned",
      render: (b) => <span className="tabular-nums">{b.churnedTenants}</span>,
    },
  ];

  const userGrowthColumns: DataTableColumn<UserGrowthBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    {
      key: "newUsers",
      header: "New users",
      render: (b) => <span className="tabular-nums">{b.newUsers}</span>,
    },
    {
      key: "cumulativeUsers",
      header: "Cumulative",
      render: (b) => <span className="tabular-nums">{b.cumulativeUsers}</span>,
    },
  ];

  const subscriptionGrowthColumns: DataTableColumn<SubscriptionGrowthBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    {
      key: "newSubscriptions",
      header: "New subs",
      render: (b) => <span className="tabular-nums">{b.newSubscriptions}</span>,
    },
    {
      key: "cumulativeSubscriptions",
      header: "Cumulative",
      render: (b) => <span className="tabular-nums">{b.cumulativeSubscriptions}</span>,
    },
  ];

  const trialConversionColumns: DataTableColumn<TrialConversionBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    {
      key: "converted",
      header: "Converted",
      render: (b) => <span className="tabular-nums">{b.converted}</span>,
    },
  ];

  const estRevenueColumns: DataTableColumn<EstRevenueBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    {
      key: "estRevenue",
      header: "Est. Revenue",
      render: (b) => <span className="tabular-nums">{b.estRevenue}</span>,
    },
  ];

  const featureAdoptionColumns: DataTableColumn<FeatureAdoptionBucket>[] = [
    {
      key: "period",
      header: "Period",
      render: (b) => <span className="tabular-nums">{b.period}</span>,
    },
    { key: "flag", header: "Flag", render: (b) => b.flag },
    {
      key: "enabledTenants",
      header: "Enabled Tenants",
      render: (b) => <span className="tabular-nums">{b.enabledTenants}</span>,
    },
  ];

  const noHistoryYet = data && data.trackingStartedAt === null;

  // Chart Mappings
  const growthSeries: TrendChartSeries[] = data
    ? [
        {
          label: "New Tenants",
          points: data.growth.map((b) => ({ period: b.period, value: b.newTenants })),
        },
        {
          label: "Cumulative",
          points: data.growth.map((b) => ({
            period: b.period,
            value: b.cumulativeTenants,
          })),
        },
      ]
    : [];

  const planChangeSeries: TrendChartSeries[] = [];
  if (data) {
    const plans = Array.from(new Set(data.planChanges.map((b) => b.plan)));
    plans.slice(0, 5).forEach((plan) => {
      planChangeSeries.push({
        label: plan,
        points: data.planChanges
          .filter((b) => b.plan === plan)
          .map((b) => ({ period: b.period, value: b.count })),
      });
    });
  }

  const churnSeries: TrendChartSeries[] = data
    ? [
        {
          label: "Churned",
          points: data.churn.map((b) => ({
            period: b.period,
            value: b.churnedTenants,
          })),
        },
      ]
    : [];

  const userGrowthSeries: TrendChartSeries[] = data
    ? [
        {
          label: "New Users",
          points: data.userGrowth.map((b) => ({ period: b.period, value: b.newUsers })),
        },
        {
          label: "Cumulative",
          points: data.userGrowth.map((b) => ({
            period: b.period,
            value: b.cumulativeUsers,
          })),
        },
      ]
    : [];

  const subscriptionGrowthSeries: TrendChartSeries[] = data
    ? [
        {
          label: "New Subs",
          points: data.subscriptionGrowth.map((b) => ({
            period: b.period,
            value: b.newSubscriptions,
          })),
        },
        {
          label: "Cumulative",
          points: data.subscriptionGrowth.map((b) => ({
            period: b.period,
            value: b.cumulativeSubscriptions,
          })),
        },
      ]
    : [];

  const trialConversionSeries: TrendChartSeries[] = data
    ? [
        {
          label: "Converted",
          points: data.trialConversion.map((b) => ({
            period: b.period,
            value: b.converted,
          })),
        },
      ]
    : [];

  const estRevenueSeries: TrendChartSeries[] = data
    ? [
        {
          label: "Est. Revenue",
          points: data.estRevenue.map((b) => ({
            period: b.period,
            value: b.estRevenue,
          })),
        },
      ]
    : [];

  const featureAdoptionSeries: TrendChartSeries[] = [];
  if (data) {
    const flags = Array.from(new Set(data.featureAdoption.map((b) => b.flag)));
    flags.slice(0, 5).forEach((flag) => {
      featureAdoptionSeries.push({
        label: flag,
        points: data.featureAdoption
          .filter((b) => b.flag === flag)
          .map((b) => ({ period: b.period, value: b.enabledTenants })),
      });
    });
  }

  return (
    <Stack gap={6}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @media print {
          .print-hidden {
            display: none !important;
          }
          .print-show {
            display: block !important;
          }
          body { background: white; color: black; }
        }
      `,
        }}
      />

      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Tenant growth, plan changes, and churn over time — read-only.
          </p>
        </div>
        <Row gap={2} className="print-hidden">
          <Button variant="outline" onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
          <Button variant="default" onClick={handleExport}>
            Export CSV
          </Button>
        </Row>
      </div>

      <Row gap={4} wrap className="print-hidden">
        <Row gap={2}>
          <Button
            variant={range === "6m" ? "default" : "outline"}
            onClick={() => setParam("range", "6m")}
          >
            6 months
          </Button>
          <Button
            variant={range === "12m" ? "default" : "outline"}
            onClick={() => setParam("range", "12m")}
          >
            12 months
          </Button>
        </Row>
        <Row gap={2}>
          <Button
            variant={granularity === "week" ? "default" : "outline"}
            onClick={() => setParam("granularity", "week")}
          >
            Weekly
          </Button>
          <Button
            variant={granularity === "month" ? "default" : "outline"}
            onClick={() => setParam("granularity", "month")}
          >
            Monthly
          </Button>
        </Row>

        <Row gap={2} className="items-center">
          <Input
            type="date"
            value={from || ""}
            onChange={(e) => setParam("from", e.target.value)}
            className="w-36"
            placeholder="From"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            value={to || ""}
            onChange={(e) => setParam("to", e.target.value)}
            className="w-36"
            placeholder="To"
          />
        </Row>

        <Row gap={2}>
          <Input
            value={tenantId || ""}
            onChange={(e) => setParam("tenantId", e.target.value)}
            placeholder="Tenant ID filter"
            className="w-40"
          />
        </Row>

        <Row gap={2}>
          <Select
            value={planId || "all"}
            onValueChange={(val) => setParam("planId", val === "all" ? null : val)}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="All plans" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plans</SelectItem>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="enterprise">Enterprise</SelectItem>
            </SelectContent>
          </Select>
        </Row>

        <Row gap={2}>
          <Select
            value={compare || "none"}
            onValueChange={(val) => setParam("compare", val === "none" ? null : val)}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="No comparison" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No comparison</SelectItem>
              <SelectItem value="day">Previous day</SelectItem>
              <SelectItem value="week">Previous week</SelectItem>
              <SelectItem value="month">Previous month</SelectItem>
              <SelectItem value="year">Previous year</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Row>

      <Card>
        <CardHeader>
          <CardTitle>Tenant growth {renderComparison("newTenants")}</CardTitle>
          <CardDescription>
            New tenants per period, plus a running cumulative total — complete history
            from day one (organization.createdAt).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart series={growthSeries} />
          <div className="mt-6">
            <DataTable
              columns={growthColumns}
              rows={data?.growth ?? []}
              rowKey={(b) => b.period}
              loading={loading}
              emptyMessage="No tenants yet."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>User growth {renderComparison("newUsers")}</CardTitle>
          <CardDescription>
            New users per period, plus running cumulative total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart series={userGrowthSeries} />
          <div className="mt-6">
            <DataTable
              columns={userGrowthColumns}
              rows={data?.userGrowth ?? []}
              rowKey={(b) => b.period}
              loading={loading}
              emptyMessage="No user growth in this window."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Subscription growth {renderComparison("newSubscriptions")}
          </CardTitle>
          <CardDescription>
            New subscriptions per period and running cumulative total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart series={subscriptionGrowthSeries} />
          <div className="mt-6">
            <DataTable
              columns={subscriptionGrowthColumns}
              rows={data?.subscriptionGrowth ?? []}
              rowKey={(b) => b.period}
              loading={loading}
              emptyMessage="No subscription growth in this window."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trial conversion {renderComparison("trialConversions")}</CardTitle>
          <CardDescription>Trial conversions per period.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart series={trialConversionSeries} />
          <div className="mt-6">
            <DataTable
              columns={trialConversionColumns}
              rows={data?.trialConversion ?? []}
              rowKey={(b) => b.period}
              loading={loading}
              emptyMessage="No trial conversions in this window."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Est. Revenue {renderComparison("estRevenue")}</CardTitle>
          <CardDescription>Estimated revenue per period.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart series={estRevenueSeries} />
          <div className="mt-6">
            <DataTable
              columns={estRevenueColumns}
              rows={data?.estRevenue ?? []}
              rowKey={(b) => b.period}
              loading={loading}
              emptyMessage="No est revenue in this window."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan changes {renderComparison("planChanges")}</CardTitle>
          <CardDescription>
            Plan changes recorded per period — not a live snapshot of who is on each
            plan as of that date. Totals cannot be summed into a population count: a
            tenant&apos;s very first plan is never itself a counted event, so the
            free-tier baseline is systematically undercounted in any such sum.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {noHistoryYet ? (
            <p className="text-sm text-muted-foreground">
              No trend data recorded yet — this begins accumulating once this feature
              ships. It does not cover history before this date.
            </p>
          ) : (
            <>
              <TrendChart series={planChangeSeries} />
              <div className="mt-6">
                <DataTable
                  columns={planChangeColumns}
                  rows={data?.planChanges ?? []}
                  rowKey={(b) => `${b.period}-${b.plan}`}
                  loading={loading}
                  emptyMessage="No plan changes in this window."
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Churn {renderComparison("churnedTenants")}</CardTitle>
          <CardDescription>
            Stripe-observable cancellation only — blind to tenant suspension/hard-delete
            and free-tier abandonment, likely the dominant real churn mode for a
            scaffold with a free plan. A webhook event suppressed by an active manual
            override is attributed to clear time, not the original event time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {noHistoryYet ? (
            <p className="text-sm text-muted-foreground">
              No trend data recorded yet — this begins accumulating once this feature
              ships. It does not cover history before this date.
            </p>
          ) : (
            <>
              <TrendChart series={churnSeries} />
              <div className="mt-6">
                <DataTable
                  columns={churnColumns}
                  rows={data?.churn ?? []}
                  rowKey={(b) => b.period}
                  loading={loading}
                  emptyMessage="No churn in this window."
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Feature adoption {renderComparison("featureAdoption")}</CardTitle>
          <CardDescription>
            Number of enabled tenants per feature flag per period.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data?.featureAdoption ? (
            <>
              <TrendChart series={featureAdoptionSeries} />
              <div className="mt-6">
                <DataTable
                  columns={featureAdoptionColumns}
                  rows={data?.featureAdoption ?? []}
                  rowKey={(b) => `${b.period}-${b.flag}`}
                  loading={loading}
                  emptyMessage="No feature adoption in this window."
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              pending feature-flag instrumentation
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active users {renderComparison("activeUsers")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">pending metering</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage {renderComparison("usage")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">pending metering</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage usage {renderComparison("storageUsage")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">pending metering</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API usage {renderComparison("apiUsage")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">pending metering</p>
        </CardContent>
      </Card>

      {data?.trackingStartedAt ? (
        <p className="text-xs text-muted-foreground">
          Trend data available from{" "}
          {new Date(data.trackingStartedAt).toLocaleDateString()}. Historical figures
          exclude deleted tenants and may decrease over time — a hard tenant delete
          retroactively erases that tenant&apos;s rows from this history.
        </p>
      ) : null}
    </Stack>
  );
}
