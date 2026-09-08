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
  Grid,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { useMemberArea } from "@/components/member/member-area-context";
import { formatCurrency, formatDateTime, formatMinutes, type PaginationMeta } from "@/lib/member/format";
import { getMySessionSummary, getMySessions, type SessionSummary, type PortalSessionSummary } from "@/lib/member/session";
import { useLiveRefresh } from "@/lib/member/use-live-refresh";

// Poll while a session is active so elapsed time / status stay current with
// no manual refresh — see use-live-refresh.ts for why polling over realtime.
const ACTIVE_SESSION_POLL_MS = 12_000;

const STATUS_VARIANT: Record<PortalSessionSummary["status"], "default" | "secondary" | "outline"> = {
  active: "default",
  paused: "secondary",
  ended: "outline",
};

/**
 * Connect's QR "scan to start" explainer, folded directly into this page
 * (member-portal-v2 phase 1 — Session absorbed Connect). Static, no data —
 * `/member/connect` now redirects here. Camera-based scanning inside the
 * member area itself stays deliberately out of scope (no cross-browser
 * dependency-free path) — the phone's native camera app is the real path.
 */
const CONNECT_STEPS = [
  {
    step: 1,
    title: "Find the QR code",
    description: "Every station has a QR code printed on its stand or displayed on its screen.",
  },
  {
    step: 2,
    title: "Scan it with your phone's camera",
    description:
      "Open your phone's native camera app (no app install needed) and point it at the code — no in-app scanner is required.",
  },
  {
    step: 3,
    title: "Confirm and start",
    description:
      "The link opens your account here. Sign in if asked, then tap Start to begin your session on that station.",
  },
] as const;

function StartSessionSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a session</CardTitle>
        <CardDescription>Start a session at any station by scanning its QR code.</CardDescription>
      </CardHeader>
      <CardContent>
        <Grid cols={3} gap={4}>
          {CONNECT_STEPS.map((s) => (
            <Card key={s.step} data-testid={`connect-step-${s.step}`}>
              <CardHeader>
                <Row items="center" className="gap-2">
                  <Badge>{s.step}</Badge>
                  <CardTitle className="text-base">{s.title}</CardTitle>
                </Row>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </Grid>
      </CardContent>
    </Card>
  );
}

export default function MemberSessionPage() {
  const { member } = useMemberArea();
  const query = useListQuery([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [items, setItems] = useState<PortalSessionSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // Guest mode — both calls are member-only and would 401 with no
    // `tenantMember` row yet.
    if (!member) {
      setLoading(false);
      return;
    }
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
  }, [member, query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  // Silent background refresh (no loading skeleton) — only the active-session
  // summary, not the paginated history table, since that's the part whose
  // status/elapsed-time display goes stale without a manual refresh.
  const refreshSummary = useCallback(async () => {
    const s = await getMySessionSummary();
    if (s.data) setSummary(s.data);
  }, []);
  useLiveRefresh(refreshSummary, ACTIVE_SESSION_POLL_MS, summary?.active != null);

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
        description="Start a session, and view your active session and history."
        actions={<RefreshButton onRefresh={load} />}
      />

      <StartSessionSection />

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
