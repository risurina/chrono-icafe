"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Skeleton,
  DataTable,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Stack,
  Row,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { formatCurrency, formatDateTime, formatMinutes, type PaginationMeta } from "@/lib/member/format";
import { getMySessionSummary, getMySessions, type SessionSummary, type PortalSessionSummary } from "@/lib/member/session";

const STATUS_VARIANT: Record<PortalSessionSummary["status"], "default" | "secondary" | "outline"> = {
  active: "default",
  paused: "secondary",
  ended: "outline",
};

export default function MemberSessionPage() {
  const query = useListQuery([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [items, setItems] = useState<PortalSessionSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [s, list] = await Promise.all([
      getMySessionSummary(),
      getMySessions({
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort ?? "startedAt",
        order: query.order,
      }),
    ]);
    if (s.data) setSummary(s.data);
    if (list.data) {
      setItems(list.data.items);
      setMeta(list.data.meta);
    }
    setLoading(false);
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<PortalSessionSummary>[] = [
    {
      key: "stationName",
      header: "Station",
      render: (row) => (
        <Link href={`/member/session/${row.id}`} className="underline underline-offset-2">
          {row.stationName}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <Badge variant={STATUS_VARIANT[row.status]} className="capitalize">
          {row.status}
        </Badge>
      ),
    },
    { key: "startedAt", header: "Started", sortable: true, render: (row) => formatDateTime(row.startedAt) },
    {
      key: "actualBillableSeconds",
      header: "Duration",
      render: (row) => (row.actualBillableSeconds != null ? formatMinutes(row.actualBillableSeconds / 60) : "—"),
    },
    {
      key: "amountCharged",
      header: "Charged",
      render: (row) => (row.amountCharged ? formatCurrency(row.amountCharged, row.currency) : "—"),
    },
  ];

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="Session"
        description="Your active session and session history."
        actions={<RefreshButton onRefresh={load} />}
      />

      <Card data-testid="active-session-card">
        <CardHeader>
          <CardTitle>Active session</CardTitle>
          <CardDescription>
            {summary?.active
              ? `Running on ${summary.active.stationName}`
              : "No active session right now."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !summary ? (
            <Skeleton className="h-10 w-40" />
          ) : summary?.active ? (
            <Row items="center" className="justify-between gap-4">
              <Stack gap={1}>
                <p className="text-sm text-muted-foreground">Started</p>
                <p className="font-medium">{formatDateTime(summary.active.startedAt)}</p>
              </Stack>
              <Link
                href={`/member/session/${summary.active.id}`}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                View details
              </Link>
            </Row>
          ) : (
            <p className="text-sm text-muted-foreground">
              Today: {formatMinutes((summary?.today.billableSeconds ?? 0) / 60)} across{" "}
              {summary?.today.sessionCount ?? 0} session(s).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session history</CardTitle>
        </CardHeader>
        <CardContent>
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
            {meta ? (
              <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} />
            ) : null}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
