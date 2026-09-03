"use client";

import { useCallback, useEffect, useState } from "react";
import type { PaginationMeta } from "agora";
import {
  Button,
  Label,
  Textarea,
  Badge,
  Stack,
  Row,
  Can,
  DataTable,
  DataTablePagination,
  DataTableToolbar,
  useListQuery,
  type DataTableColumn,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "agora/ui";
import { api } from "@/lib/rpc";

type SaleRow = {
  id: string;
  branchId: string;
  shiftId: string | null;
  memberId: string | null;
  memberName: string | null;
  customerName: string | null;
  cashierUserId: string;
  cashierName: string;
  status: "completed" | "refunded";
  totalAmount: string;
  amountTendered: string;
  changeAmount: string;
  createdAt: string;
};

type SaleItem = {
  id: string;
  productId: string | null;
  name: string;
  sku: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
};

type SalePayment = {
  id: string;
  method: "cash" | "card" | "wallet";
  amount: string;
  referenceNumber: string | null;
};

type RawSaleRow = Omit<SaleRow, "memberName" | "cashierName">;

type SaleDetail = { sale: RawSaleRow; items: SaleItem[]; payments: SalePayment[] };

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export default function PosHistoryPage() {
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [viewing, setViewing] = useState<SaleDetail | null>(null);
  const [refunding, setRefunding] = useState<SaleRow | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refunding_, setRefundingBusy] = useState(false);
  const query = useListQuery();

  const load = useCallback(async () => {
    const res = await api.rpc.pos.sales.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setSales(body.items as SaleRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  async function openView(sale: SaleRow) {
    const res = await api.rpc.pos.sales[":id"].$get({ param: { id: sale.id } });
    if (res.ok) {
      const body = (await res.json()) as SaleDetail;
      setViewing(body);
    }
  }

  function openRefund(sale: SaleRow) {
    setRefunding(sale);
    setRefundReason("");
  }

  async function submitRefund(e: React.FormEvent) {
    e.preventDefault();
    if (!refunding || !refundReason.trim()) return;
    setRefundingBusy(true);
    const res = await api.rpc.pos.sales[":id"].refund.$post({
      param: { id: refunding.id },
      json: { reason: refundReason.trim() },
    });
    setRefundingBusy(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not refund sale."));
      return;
    }
    toast.success("Sale refunded.");
    setRefunding(null);
    load();
  }

  function renderStatus(s: SaleRow) {
    return (
      <Badge variant={s.status === "completed" ? "success" : "secondary"} className="capitalize">
        {s.status}
      </Badge>
    );
  }

  function renderActions(s: SaleRow) {
    return (
      <Row items="center">
        <Button variant="ghost" size="sm" onClick={() => openView(s)}>
          View
        </Button>
        {s.status === "completed" ? (
          <Can permissions={me?.permissions} resource="pos" action="void">
            <Button variant="ghost" size="sm" onClick={() => openRefund(s)}>
              Refund
            </Button>
          </Can>
        ) : null}
      </Row>
    );
  }

  const columns: DataTableColumn<SaleRow>[] = [
    {
      key: "createdAt",
      header: "Date",
      sortable: true,
      render: (s) => new Date(s.createdAt).toLocaleString(),
    },
    { key: "cashierName", header: "Cashier" },
    {
      key: "memberName",
      header: "Customer",
      render: (s) => s.memberName ?? s.customerName ?? "Walk-in",
    },
    { key: "totalAmount", header: "Total", sortable: true, render: (s) => `₱${s.totalAmount}` },
    { key: "status", header: "Status", render: renderStatus },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sale history</h1>
        <p className="text-sm text-muted-foreground">Past POS sales and refunds.</p>
      </div>

      <DataTableToolbar q={query.q} onQChange={query.setQ} searchPlaceholder="Search…" />

      <DataTable
        columns={columns}
        rows={sales}
        rowKey={(row) => row.id}
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
        emptyMessage="No sales yet."
      />

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Receipt</DialogTitle>
          </DialogHeader>
          {viewing ? (
            <Stack gap={4}>
              <div className="text-sm text-muted-foreground">
                {viewing.sale.customerName ?? (viewing.sale.memberId ? "Member sale" : "Walk-in")} ·{" "}
                {new Date(viewing.sale.createdAt).toLocaleString()}
              </div>
              <ul className="divide-y divide-border text-sm">
                {viewing.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between py-2">
                    <span>
                      {item.quantity}× {item.name}
                    </span>
                    <span>₱{item.lineTotal}</span>
                  </li>
                ))}
              </ul>
              <div className="space-y-1 text-sm">
                {viewing.payments.map((p) => (
                  <div key={p.id} className="flex justify-between capitalize">
                    <span>{p.method}</span>
                    <span>₱{p.amount}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between font-medium">
                <span>Total</span>
                <span>₱{viewing.sale.totalAmount}</span>
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Change</span>
                <span>₱{viewing.sale.changeAmount}</span>
              </div>
              <Button variant="outline" onClick={() => window.print()}>
                Print
              </Button>
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!refunding} onOpenChange={(open) => !open && setRefunding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund sale</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitRefund} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="refundReason">Reason</Label>
              <Textarea
                id="refundReason"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRefunding(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={refunding_}>
                {refunding_ ? "Refunding…" : "Confirm refund"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
