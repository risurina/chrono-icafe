"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
  Button,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "agora/ui";
import { api } from "@/lib/rpc";

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

type Branch = { id: string; name: string };

type SalesSummary = {
  totalRevenue: string;
  saleCount: number;
  averageSaleValue: string;
  byCategory: { category: string; revenue: string; quantity: number }[];
  byPaymentMethod: { method: string; amount: string }[];
  dailySeries: { date: string; revenue: string }[];
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function SalesReportPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [from, setFrom] = useState(daysAgoIso(30));
  const [to, setTo] = useState(todayIso());
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) setMe((await res.json()) as Me);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.branches.$get({ query: { page: "1", pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setBranches((body.items as Branch[]).map((b) => ({ id: b.id, name: b.name })));
      }
    })();
  }, []);

  const canSeeAllBranches = me?.permissions?.report?.includes("readFinancial") ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.rpc.reports["sales-summary"].$get({
      query: { from, to, ...(branchId ? { branchId } : {}) },
    });
    if (res.ok) {
      setSummary((await res.json()) as SalesSummary);
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Failed to load sales summary.");
      setSummary(null);
    }
    setLoading(false);
  }, [from, to, branchId]);

  useEffect(() => {
    // Staff must pick a branch before this call succeeds — skip until then.
    if (!branchId && !canSeeAllBranches) {
      setLoading(false);
      setSummary(null);
      return;
    }
    load();
  }, [load, branchId, canSeeAllBranches]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales report</h1>
        <p className="text-sm text-muted-foreground">
          Revenue breakdown by category and payment method.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="space-y-2">
            <Label htmlFor="branch">Branch</Label>
            <Select value={branchId || "__all__"} onValueChange={(v) => setBranchId(v === "__all__" ? "" : v)}>
              <SelectTrigger id="branch" className="w-48">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {canSeeAllBranches ? (
                  <SelectItem value="__all__">All branches</SelectItem>
                ) : null}
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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

      {!branchId && !canSeeAllBranches ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Select a branch to view its sales report.
          </CardContent>
        </Card>
      ) : error ? (
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
                <CardTitle className="text-sm text-muted-foreground">Total revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">{summary.totalRevenue}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Sales</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">{summary.saleCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">Average sale</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tracking-tight">{summary.averageSaleValue}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>By category</CardTitle>
                <CardDescription>Revenue and quantity per product category.</CardDescription>
              </CardHeader>
              <CardContent>
                {summary.byCategory.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sales in this range.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.byCategory.map((c) => (
                        <TableRow key={c.category}>
                          <TableCell>{c.category}</TableCell>
                          <TableCell className="text-right">{c.quantity}</TableCell>
                          <TableCell className="text-right">{c.revenue}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>By payment method</CardTitle>
                <CardDescription>Amount tendered per method.</CardDescription>
              </CardHeader>
              <CardContent>
                {summary.byPaymentMethod.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sales in this range.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.byPaymentMethod.map((p) => (
                        <TableRow key={p.method}>
                          <TableCell className="capitalize">{p.method}</TableCell>
                          <TableCell className="text-right">{p.amount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
