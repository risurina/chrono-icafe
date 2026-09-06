"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  DataTable,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Stack,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { formatCurrency, formatDateTime, type PaginationMeta } from "@/lib/member/format";
import { getMyWalletHistory, type WalletTransaction } from "@/lib/member/wallet";
import { getMyCreditLedger, type CreditLedgerEntry } from "@/lib/member/credits";
import { getMySessions, type PortalSessionSummary } from "@/lib/member/session";

/**
 * Tabbed history: Wallet / Credits / Sessions, each independently
 * paginated (client-side per-tab, no cross-tab merge — a true unified feed
 * needs a new `GET /portal/activity` endpoint, out of scope per the plan).
 *
 * A fourth "Promos" tab (member-portal-v2 phase 1 — History absorbed Promos)
 * is a link-out card, not inlined content: `/member/promos` keeps its own
 * page and its own approval gate (`requiresApproval`, `member-gate.tsx`), so
 * inlining its catalog here would silently bypass that gate for a pending
 * applicant. It's simply no longer a separate top-level nav entry.
 */
function WalletTab() {
  const query = useListQuery([]);
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyWalletHistory({
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort ?? "createdAt",
      order: query.order,
    });
    if (res.data) {
      setItems(res.data.items);
      setMeta(res.data.meta);
    }
    setLoading(false);
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<WalletTransaction>[] = [
    { key: "type", header: "Type", render: (row) => <Badge className="capitalize">{row.type}</Badge> },
    { key: "amount", header: "Amount", render: (row) => formatCurrency(row.amount) },
    { key: "reason", header: "Reason", render: (row) => row.reason },
    { key: "createdAt", header: "Date", sortable: true, render: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <Stack gap={4}>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(row) => row.id}
        loading={loading}
        emptyMessage="No wallet activity yet."
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
      />
      {meta ? <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} /> : null}
    </Stack>
  );
}

function CreditsTab() {
  const query = useListQuery([]);
  const [items, setItems] = useState<CreditLedgerEntry[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyCreditLedger({
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort ?? "createdAt",
      order: query.order,
    });
    if (res.data) {
      setItems(res.data.items);
      setMeta(res.data.meta);
    }
    setLoading(false);
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<CreditLedgerEntry>[] = [
    { key: "type", header: "Type", render: (row) => <Badge className="capitalize">{row.type}</Badge> },
    { key: "quantityDelta", header: "Minutes", render: (row) => row.quantityDelta },
    { key: "reason", header: "Reason", render: (row) => row.reason },
    { key: "createdAt", header: "Date", sortable: true, render: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <Stack gap={4}>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(row) => row.id}
        loading={loading}
        emptyMessage="No credit activity yet."
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
      />
      {meta ? <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} /> : null}
    </Stack>
  );
}

function SessionsTab() {
  const query = useListQuery([]);
  const [items, setItems] = useState<PortalSessionSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMySessions({
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort ?? "startedAt",
      order: query.order,
    });
    if (res.data) {
      setItems(res.data.items);
      setMeta(res.data.meta);
    }
    setLoading(false);
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<PortalSessionSummary>[] = [
    { key: "stationName", header: "Station" },
    { key: "status", header: "Status", render: (row) => <Badge className="capitalize">{row.status}</Badge> },
    { key: "startedAt", header: "Started", sortable: true, render: (row) => formatDateTime(row.startedAt) },
    {
      key: "amountCharged",
      header: "Charged",
      render: (row) => (row.amountCharged ? formatCurrency(row.amountCharged, row.currency) : "—"),
    },
  ];

  return (
    <Stack gap={4}>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(row) => row.id}
        loading={loading}
        emptyMessage="No sessions yet."
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
      />
      {meta ? <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} /> : null}
    </Stack>
  );
}

function PromosTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit packs & promotions</CardTitle>
        <CardDescription>
          Buy credit packs and see current promotions on the Promos page.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Link href="/member/promos" className={cn(buttonVariants({ variant: "outline" }))}>
          View promos
        </Link>
      </CardFooter>
    </Card>
  );
}

export default function MemberHistoryPage() {
  const [tab, setTab] = useState("wallet");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="History"
        description="Your wallet, credit, and session activity, plus promos and credit packs."
        actions={<RefreshButton onRefresh={() => setRefreshKey((k) => k + 1)} />}
      />
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="wallet">Wallet</TabsTrigger>
              <TabsTrigger value="credits">Credits</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="promos">Promos</TabsTrigger>
            </TabsList>
            <TabsContent value="wallet">
              <WalletTab key={`wallet-${refreshKey}`} />
            </TabsContent>
            <TabsContent value="credits">
              <CreditsTab key={`credits-${refreshKey}`} />
            </TabsContent>
            <TabsContent value="sessions">
              <SessionsTab key={`sessions-${refreshKey}`} />
            </TabsContent>
            <TabsContent value="promos">
              <PromosTab />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </Stack>
  );
}
