"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Badge,
  Stack,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type Shift = {
  id: string;
  branchId: string;
  staffName: string;
  status: "open" | "closed";
  openingCashAmount: string;
  closedAt: string | null;
  actualCashAmount: string | null;
  expectedCashAmount: string | null;
  differenceAmount: string | null;
};

type ReconciliationSummary = {
  expectedCashAmount: string | null;
  actualCashAmount: string | null;
  differenceAmount: string | null;
};

export default function ReconciliationPage() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const query = useListQuery();

  const [detailShiftId, setDetailShiftId] = useState<string | null>(null);
  const [detailSummary, setDetailSummary] = useState<ReconciliationSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Server-side pagination is over ALL closed shifts (there is no
  // list-by-nonzero-variance endpoint — reconciliation Phase 4 only shipped
  // a per-shift read route, not a list route). This page filters the
  // returned page to nonzero variance client-side, so a page of results can
  // legitimately show fewer rows than its page size, or none at all, even
  // when nonzero-variance shifts exist on other pages. Acceptable for this
  // pass; a dedicated filtered list endpoint would be a follow-up.
  const load = useCallback(async () => {
    const res = await api.rpc.shifts.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: "closedAt",
        order: "desc",
        status: "closed",
      },
    });
    if (res.ok) {
      const body = await res.json();
      setShifts(body.items as Shift[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  const varianceShifts = shifts.filter(
    (s) => s.differenceAmount !== null && s.differenceAmount !== "0.00",
  );

  function openDetail(shiftId: string) {
    setDetailShiftId(shiftId);
    setDetailSummary(null);
    setDetailLoading(true);
    api.rpc.reconciliation.shifts[":id"].$get({ param: { id: shiftId } }).then(async (res) => {
      if (res.ok) {
        const body = await res.json();
        setDetailSummary(body.summary);
      }
      setDetailLoading(false);
    });
  }

  const columns: DataTableColumn<Shift>[] = [
    { key: "staffName", header: "Staff", render: (s) => s.staffName },
    {
      key: "closedAt",
      header: "Closed",
      render: (s) => (s.closedAt ? new Date(s.closedAt).toLocaleString() : "—"),
    },
    { key: "expectedCashAmount", header: "Expected", render: (s) => s.expectedCashAmount ?? "—" },
    { key: "actualCashAmount", header: "Actual", render: (s) => s.actualCashAmount ?? "—" },
    {
      key: "differenceAmount",
      header: "Variance",
      render: (s) => (
        <Badge variant={s.differenceAmount && s.differenceAmount.startsWith("-") ? "destructive" : "warning"}>
          {s.differenceAmount ?? "—"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (s) => (
        <Button variant="ghost" size="sm" onClick={() => openDetail(s.id)}>
          View breakdown
        </Button>
      ),
    },
  ];

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Closed shifts with a cash variance between expected and counted amounts.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shifts with a variance</CardTitle>
          <CardDescription>
            Filtered from this page&apos;s closed shifts — a shift with no variance is
            hidden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTableToolbar q={query.q} onQChange={query.setQ} searchPlaceholder="Search…" />
          <DataTable
            columns={columns}
            rows={varianceShifts}
            rowKey={(s) => s.id}
            emptyMessage="No variance on this page."
          />
          {meta ? (
            <DataTablePagination
              meta={meta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={detailShiftId !== null} onOpenChange={(open) => !open && setDetailShiftId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Shift breakdown</DialogTitle>
          </DialogHeader>
          <Stack gap={4}>
            {detailLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : detailSummary ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Expected cash</dt>
                <dd>{detailSummary.expectedCashAmount ?? "—"}</dd>
                <dt className="text-muted-foreground">Actual cash</dt>
                <dd>{detailSummary.actualCashAmount ?? "—"}</dd>
                <dt className="text-muted-foreground">Variance</dt>
                <dd>{detailSummary.differenceAmount ?? "—"}</dd>
              </dl>
            ) : (
              <p className="text-sm text-destructive">Could not load breakdown.</p>
            )}
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
