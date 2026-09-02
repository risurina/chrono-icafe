"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Label,
  Input,
  Button,
  TrendChart,
  type TrendChartSeries,
} from "agora/ui";
import { api } from "@/lib/rpc";

type WalletActivitySummary = {
  totalCredited: string;
  totalDebited: string;
  netChange: string;
  transactionCount: number;
  dailySeries: { date: string; credited: string; debited: string }[];
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function WalletActivityReportPage() {
  const [from, setFrom] = useState(daysAgoIso(30));
  const [to, setTo] = useState(todayIso());
  const [summary, setSummary] = useState<WalletActivitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.rpc.reports["wallet-activity"].$get({ query: { from, to } });
    if (res.ok) {
      setSummary((await res.json()) as WalletActivitySummary);
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(
        res.status === 403
          ? "You don't have permission to view wallet activity."
          : (body?.error ?? "Failed to load wallet activity."),
      );
      setSummary(null);
    }
    setLoading(false);
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const series: TrendChartSeries[] = [
    {
      label: "Credited",
      points: summary?.dailySeries.map((d) => ({ period: d.date, value: Number(d.credited) })) ?? [],
    },
    {
      label: "Debited",
      points:
        summary?.dailySeries.map((d) => ({ period: d.date, value: Math.abs(Number(d.debited)) })) ?? [],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wallet activity</h1>
        <p className="text-sm text-muted-foreground">
          Tenant-wide wallet credit/debit rollup.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="space-y-2">
            <Label htmlFor="from">From</Label>
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : summary ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Credited</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">{summary.totalCredited}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Debited</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">{summary.totalDebited}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Net change</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">{summary.netChange}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Daily activity</CardTitle>
              <CardDescription>{summary.transactionCount} transactions in range.</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendChart series={series} ariaLabel="Daily wallet credit and debit activity" />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
