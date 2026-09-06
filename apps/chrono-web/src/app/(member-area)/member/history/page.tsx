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
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { formatCurrency, formatDateTime, type PaginationMeta } from "@/lib/member/format";
import { getMyActivity, type ActivityEvent, type ActivityEventType } from "@/lib/member/activity";

const TYPE_LABELS: Record<ActivityEventType, string> = {
  wallet: "Wallet",
  credit: "Credits",
  session: "Session",
  reservation: "Reservation",
};

/**
 * member-portal-v2 Phase 8 — unified Activity feed. Replaces the old
 * Wallet/Credits/Sessions tabs with one server-paginated, sorted timeline
 * from `GET /portal/activity` (a real SQL-level UNION ALL across the four
 * source tables, not four separate fetches merged client-side).
 *
 * Promos stays a link-out card, not inlined content: `/member/promos` keeps
 * its own page and its own approval gate (`requiresApproval`,
 * `member-gate.tsx`), so inlining its catalog here would silently bypass
 * that gate for a pending applicant. A credit-pack purchase already shows up
 * in the feed itself as a "Credits granted" row (the purchase mints a
 * `chronoCreditGrantLedgerEntry`), so this card is purely a shortcut to buy
 * more — nothing is hidden by removing its old tab.
 */
function PromosCard() {
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

function ActivityFeed({ refreshKey }: { refreshKey: number }) {
  const query = useListQuery(["type"]);
  const [items, setItems] = useState<ActivityEvent[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const typeFilter = (query.filters.type as ActivityEventType | undefined) ?? undefined;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyActivity({
      page: query.page,
      pageSize: query.pageSize,
      type: typeFilter,
      q: query.q || undefined,
      sort: query.sort ?? "occurredAt",
      // No explicit sort chosen yet → default to newest-first, the natural
      // order for a timeline feed. Once the member clicks the Date header,
      // `useListQuery.setSort` sets both `sort` and `order` together and
      // that explicit choice is honored as-is.
      order: query.sort ? query.order : "desc",
    });
    if (res.data) {
      setItems(res.data.items);
      setMeta(res.data.meta);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.page, query.pageSize, typeFilter, query.q, query.sort, query.order, refreshKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<ActivityEvent>[] = [
    {
      key: "title",
      header: "Activity",
      render: (row) => (
        <Stack gap={0}>
          <span className="font-medium">{row.title}</span>
          <span className="text-xs text-muted-foreground">{row.description}</span>
        </Stack>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (row) => <Badge variant="secondary">{TYPE_LABELS[row.type]}</Badge>,
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => (row.amount ? formatCurrency(row.amount) : "—"),
    },
    {
      key: "occurredAt",
      header: "Date",
      sortable: true,
      render: (row) => formatDateTime(row.occurredAt),
    },
  ];

  return (
    <Stack gap={4}>
      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search activity…"
      >
        <Select
          value={typeFilter ?? "all"}
          onValueChange={(value) =>
            query.setFilters({ type: value === "all" ? undefined : value })
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="wallet">Wallet</SelectItem>
            <SelectItem value="credit">Credits</SelectItem>
            <SelectItem value="session">Sessions</SelectItem>
            <SelectItem value="reservation">Reservations</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(row) => `${row.type}-${row.id}`}
        loading={loading}
        emptyMessage="No activity yet."
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
      />
      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}
    </Stack>
  );
}

export default function MemberHistoryPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="History"
        description="Your wallet, credit, session, and reservation activity in one feed, plus promos and credit packs."
        actions={<RefreshButton onRefresh={() => setRefreshKey((k) => k + 1)} />}
      />
      <PromosCard />
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityFeed key={refreshKey} refreshKey={refreshKey} />
        </CardContent>
      </Card>
    </Stack>
  );
}
