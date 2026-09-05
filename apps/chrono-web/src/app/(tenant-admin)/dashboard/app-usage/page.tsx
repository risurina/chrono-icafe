"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Stack,
  Label,
  Input,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  useClientListPage,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";
import { computeElapsedSeconds, formatDuration } from "@/lib/session-time";

type Category = "app" | "game";

type CurrentRun = {
  id: string;
  stationId: string;
  branchId: string;
  category: Category;
  appName: string;
  startedAt: string;
};

type SummaryRow = {
  appName: string;
  category: Category;
  sessionCount: number;
  totalDurationSeconds: number;
};

type Branch = { id: string; name: string };
type Station = { id: string; name: string; branchId: string };

const CATEGORY_VARIANT: Record<Category, "default" | "secondary"> = {
  app: "secondary",
  game: "default",
};

// Currently Running has no server-side "all stations" endpoint (the
// device-ingest contract deliberately scopes GET /current to one station at
// a time — see the module plan's API surface). This merges one call per
// station in scope client-side; low-cardinality (bounded by station count),
// so useClientListPage is the right fit per .ai/rules/data-listing.md.
const CURRENT_FILTER_KEYS = ["branchId", "stationId"];
const SUMMARY_FILTER_KEYS = ["branchId", "category", "from", "to"];
const CURRENT_POLL_MS = 15_000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function AppUsagePage() {
  const currentQuery = useListQuery(CURRENT_FILTER_KEYS);
  const summaryQuery = useListQuery(SUMMARY_FILTER_KEYS);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [stations, setStations] = useState<Station[]>([]);

  const [currentRows, setCurrentRows] = useState<CurrentRun[]>([]);
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([]);
  const [summaryMeta, setSummaryMeta] = useState<PaginationMeta | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    (async () => {
      const res = await api.rpc.branches.$get({ query: { pageSize: "100" } });
      if (res.ok) setBranches((await res.json()).items as Branch[]);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.stations.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setStations(
          (body.items as { id: string; name: string; branchId: string }[]).map((s) => ({
            id: s.id,
            name: s.name,
            branchId: s.branchId,
          })),
        );
      }
    })();
  }, []);

  function branchName(id: string): string {
    return branches.find((b) => b.id === id)?.name ?? id;
  }
  function stationName(id: string): string {
    return stations.find((s) => s.id === id)?.name ?? id;
  }

  // ── Currently Running ──
  const currentBranchId = currentQuery.filters.branchId ?? "";
  const currentStationId = currentQuery.filters.stationId ?? "";

  const stationsInScope = useMemo(() => {
    let scoped = stations;
    if (currentBranchId) scoped = scoped.filter((s) => s.branchId === currentBranchId);
    if (currentStationId) scoped = scoped.filter((s) => s.id === currentStationId);
    return scoped;
  }, [stations, currentBranchId, currentStationId]);

  const loadCurrent = useCallback(async () => {
    if (stationsInScope.length === 0) {
      setCurrentRows([]);
      setNow(Date.now());
      return;
    }
    const perStation = await Promise.all(
      stationsInScope.map(async (station) => {
        const res = await api.rpc["app-usage"].current.$get({
          query: { stationId: station.id },
        });
        if (!res.ok) return [] as CurrentRun[];
        const body = await res.json();
        return (body.items as CurrentRun[]).map((r) => ({ ...r, stationId: station.id }));
      }),
    );
    setCurrentRows(perStation.flat());
    setNow(Date.now());
  }, [stationsInScope]);

  useEffect(() => {
    loadCurrent();
    const timer = setInterval(loadCurrent, CURRENT_POLL_MS);
    return () => clearInterval(timer);
  }, [loadCurrent]);

  const currentList = useClientListPage(currentRows, currentQuery, (r) => [
    r.appName,
    stationName(r.stationId),
    branchName(r.branchId),
  ]);

  const currentColumns: DataTableColumn<CurrentRun>[] = [
    { key: "station", header: "Station", render: (r) => stationName(r.stationId) },
    { key: "branch", header: "Branch", render: (r) => branchName(r.branchId) },
    {
      key: "category",
      header: "Category",
      render: (r) => <Badge variant={CATEGORY_VARIANT[r.category]}>{r.category}</Badge>,
    },
    { key: "appName", header: "App / Game", render: (r) => r.appName },
    {
      key: "startedAt",
      header: "Started",
      render: (r) => new Date(r.startedAt).toLocaleString(),
    },
    {
      key: "elapsed",
      header: "Running for",
      render: (r) =>
        formatDuration(
          computeElapsedSeconds({ status: "active", startedAt: r.startedAt, pausedAt: null }, now),
        ),
    },
  ];

  // ── Usage Summary ──
  const summaryBranchId = summaryQuery.filters.branchId ?? "";
  const summaryCategory = (summaryQuery.filters.category ?? "") as Category | "";
  const summaryFrom = summaryQuery.filters.from ?? daysAgoIso(30);
  const summaryTo = summaryQuery.filters.to ?? todayIso();

  const loadSummary = useCallback(async () => {
    const res = await api.rpc["app-usage"].summary.$get({
      query: {
        page: String(summaryQuery.page),
        pageSize: String(summaryQuery.pageSize),
        from: new Date(`${summaryFrom}T00:00:00.000Z`).toISOString(),
        to: new Date(`${summaryTo}T23:59:59.999Z`).toISOString(),
        ...(summaryBranchId ? { branchId: summaryBranchId } : {}),
        ...(summaryCategory ? { category: summaryCategory } : {}),
      },
    });
    if (res.ok) {
      const body = await res.json();
      setSummaryRows(body.items as SummaryRow[]);
      setSummaryMeta(body.meta as PaginationMeta);
    } else {
      setSummaryRows([]);
      setSummaryMeta(null);
    }
  }, [summaryBranchId, summaryCategory, summaryFrom, summaryTo, summaryQuery.page, summaryQuery.pageSize]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const summaryColumns: DataTableColumn<SummaryRow>[] = [
    { key: "appName", header: "App / Game", render: (r) => r.appName },
    {
      key: "category",
      header: "Category",
      render: (r) => <Badge variant={CATEGORY_VARIANT[r.category]}>{r.category}</Badge>,
    },
    { key: "sessionCount", header: "Sessions", render: (r) => r.sessionCount },
    {
      key: "totalDurationSeconds",
      header: "Total duration",
      render: (r) => formatDuration(r.totalDurationSeconds),
    },
  ];

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">App Usage</h1>
        <p className="text-sm text-muted-foreground">
          Per-station app/game telemetry — what's running right now, and usage totals over time.
        </p>
      </div>

      <Stack gap={3}>
        <h2 className="text-lg font-semibold">Currently Running</h2>
        <DataTableToolbar
          q={currentQuery.q}
          onQChange={currentQuery.setQ}
          searchPlaceholder="Search app/station…"
        >
          <div className="w-48">
            <Label className="sr-only">Branch</Label>
            <Select
              value={currentBranchId || "all"}
              onValueChange={(v) =>
                currentQuery.setFilters({ branchId: v === "all" ? undefined : v, stationId: undefined })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-48">
            <Label className="sr-only">Station</Label>
            <Select
              value={currentStationId || "all"}
              onValueChange={(v) => currentQuery.setFilters({ stationId: v === "all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="All stations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stations</SelectItem>
                {stations
                  .filter((s) => !currentBranchId || s.branchId === currentBranchId)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </DataTableToolbar>

        <DataTable
          columns={currentColumns}
          rows={currentList.items}
          rowKey={(r) => r.id}
          sort={currentQuery.sort}
          order={currentQuery.order}
          onSortChange={currentQuery.setSort}
          emptyMessage="Nothing currently running."
        />
        <DataTablePagination
          meta={currentList.meta}
          onPageChange={currentQuery.setPage}
          onPageSizeChange={currentQuery.setPageSize}
        />
      </Stack>

      <Stack gap={3}>
        <h2 className="text-lg font-semibold">Usage Summary</h2>
        <DataTableToolbar q={summaryQuery.q} onQChange={summaryQuery.setQ} searchPlaceholder="Search app/game…">
          <div className="w-48">
            <Label className="sr-only">Branch</Label>
            <Select
              value={summaryBranchId || "all"}
              onValueChange={(v) => summaryQuery.setFilters({ branchId: v === "all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <Label className="sr-only">Category</Label>
            <Select
              value={summaryCategory || "all"}
              onValueChange={(v) => summaryQuery.setFilters({ category: v === "all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                <SelectItem value="app">App</SelectItem>
                <SelectItem value="game">Game</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="summary-from" className="sr-only">
              From
            </Label>
            <Input
              id="summary-from"
              type="date"
              value={summaryFrom}
              onChange={(e) => summaryQuery.setFilters({ from: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="summary-to" className="sr-only">
              To
            </Label>
            <Input
              id="summary-to"
              type="date"
              value={summaryTo}
              onChange={(e) => summaryQuery.setFilters({ to: e.target.value })}
            />
          </div>
        </DataTableToolbar>

        <DataTable
          columns={summaryColumns}
          rows={summaryRows}
          rowKey={(r) => `${r.appName}:${r.category}`}
          sort={summaryQuery.sort}
          order={summaryQuery.order}
          onSortChange={summaryQuery.setSort}
          emptyMessage="No usage recorded in this range."
        />
        {summaryMeta ? (
          <DataTablePagination
            meta={summaryMeta}
            onPageChange={summaryQuery.setPage}
            onPageSizeChange={summaryQuery.setPageSize}
          />
        ) : null}
      </Stack>
    </Stack>
  );
}
