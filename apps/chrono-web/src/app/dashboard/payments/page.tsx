"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Badge,
  Stack,
  Row,
  Can,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type PaymentRow = {
  id: string;
  memberId: string | null;
  sessionId: string | null;
  amount: string;
  currency: string;
  method: string;
  status: "pending" | "paid" | "voided" | "refunded";
  providerReference: string | null;
  paidAt: string | null;
  createdAt: string;
};

type Me = { role: string; permissions: Record<string, string[]> };

function statusBadgeVariant(status: PaymentRow["status"]) {
  if (status === "paid") return "success" as const;
  if (status === "pending") return "secondary" as const;
  if (status === "voided") return "warning" as const;
  return "destructive" as const; // refunded
}

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const query = useListQuery();

  const loadPayments = useCallback(async () => {
    const res = await api.rpc.payments.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setPayments(body.items as PaymentRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as { role: string; permissions: Record<string, string[]> };
        setMe({ role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  const [confirmDialog, setConfirmDialog] = useState<{
    action: "pay" | "void" | "refund";
    payment: PaymentRow;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  function closeConfirmDialog() {
    setConfirmDialog(null);
  }

  async function submitConfirm() {
    if (!confirmDialog) return;
    setSaving(true);
    try {
      const { action, payment } = confirmDialog;
      const res =
        action === "pay"
          ? await api.rpc.payments[":id"].pay.$post({
              param: { id: payment.id },
              json: {},
            })
          : action === "void"
            ? await api.rpc.payments[":id"].void.$post({
                param: { id: payment.id },
                json: {},
              })
            : await api.rpc.payments[":id"].refund.$post({
                param: { id: payment.id },
                json: {},
              });

      if (res.ok) {
        toast.success(
          action === "pay" ? "Payment settled." : action === "void" ? "Payment voided." : "Payment refunded.",
        );
        closeConfirmDialog();
        loadPayments();
      } else {
        const message = await extractError(
          res,
          action === "pay"
            ? "Could not settle payment."
            : action === "void"
              ? "Could not void payment."
              : "Could not refund payment.",
        );
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  }

  const renderActions = (payment: PaymentRow) => (
    <Row shrink items="center">
      {payment.status === "pending" && (
        <Can permissions={me?.permissions} resource="payment" action="pay">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDialog({ action: "pay", payment })}
          >
            Settle
          </Button>
        </Can>
      )}
      {payment.status === "paid" && (
        <>
          <Can permissions={me?.permissions} resource="payment" action="void">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDialog({ action: "void", payment })}
            >
              Void
            </Button>
          </Can>
          <Can permissions={me?.permissions} resource="payment" action="refund">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDialog({ action: "refund", payment })}
            >
              Refund
            </Button>
          </Can>
        </>
      )}
    </Row>
  );

  const columns: DataTableColumn<PaymentRow>[] = [
    {
      key: "amount",
      header: "Amount",
      sortable: false,
      render: (row) => `${row.currency} ${row.amount}`,
    },
    { key: "method", header: "Method", sortable: false },
    {
      key: "status",
      header: "Status",
      sortable: false,
      render: (row) => (
        <Badge variant={statusBadgeVariant(row.status)} className="capitalize">
          {row.status}
        </Badge>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (row) => new Date(row.createdAt).toLocaleString(),
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Record and settle counter payments, then void or refund a mistake.
        </p>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search payments…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={payments}
          rowKey={(row) => row.id}
          emptyMessage="No payments yet."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {row.currency} {row.amount}
                </p>
                <p className="truncate text-xs text-muted-foreground">{row.method}</p>
                <Badge variant={statusBadgeVariant(row.status)} className="capitalize">
                  {row.status}
                </Badge>
              </div>
              {renderActions(row)}
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={payments}
          rowKey={(row) => row.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No payments yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      <Dialog open={!!confirmDialog} onOpenChange={(open) => !open && closeConfirmDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDialog?.action === "pay"
                ? "Settle this payment?"
                : confirmDialog?.action === "void"
                  ? "Void this payment?"
                  : "Refund this payment?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmDialog?.payment.currency} {confirmDialog?.payment.amount} via{" "}
            {confirmDialog?.payment.method}
            {confirmDialog?.action !== "pay"
              ? " — any wallet top-up it funded will be reversed."
              : null}
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeConfirmDialog}>
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={submitConfirm}>
              {saving
                ? "Saving…"
                : confirmDialog?.action === "pay"
                  ? "Confirm Settle"
                  : confirmDialog?.action === "void"
                    ? "Confirm Void"
                    : "Confirm Refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
