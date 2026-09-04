"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Sparkline,
  TrendChart,
  Button,
  Can,
  type TrendChartSeries,
  type SparklinePoint,
} from "agora/ui";
import { api } from "@/lib/rpc";

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

type DashboardOverview = {
  today: {
    revenue: string;
    saleCount: number;
    openShiftCount: number;
  };
  trend: { date: string; revenue: string }[];
};

export default function ReportsOverviewPage() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await api.rpc.reports.overview.$get();
    if (res.ok) {
      setOverview((await res.json()) as DashboardOverview);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) setMe((await res.json()) as Me);
    })();
  }, []);

  const revenueTrend: SparklinePoint[] =
    overview?.trend.map((t) => ({ date: t.date, value: Number(t.revenue) })) ?? [];
  const revenueSeries: TrendChartSeries[] = [
    {
      label: "Revenue",
      points: overview?.trend.map((t) => ({ period: t.date, value: Number(t.revenue) })) ?? [],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Last 14 days across every branch you have access to.
        </p>
      </div>

      <div className="flex gap-2">
        <Link href="/admin/reports/sales">
          <Button variant="outline">Sales report</Button>
        </Link>
        <Can permissions={me?.permissions} resource="report" action="readFinancial">
          <Link href="/admin/reports/wallet">
            <Button variant="outline">Wallet activity</Button>
          </Link>
        </Can>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Today&apos;s revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">
                  {overview?.today.revenue ?? "0.00"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Today&apos;s sales</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">
                  {overview?.today.saleCount ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Open shifts</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">
                  {overview?.today.openShiftCount ?? 0}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Revenue trend</CardTitle>
              <CardDescription>Last 14 days.</CardDescription>
            </CardHeader>
            <CardContent>
              <Sparkline data={revenueTrend} className="mb-4" />
              <TrendChart series={revenueSeries} ariaLabel="14-day revenue trend" />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
