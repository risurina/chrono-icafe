"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  DateTimeInput,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type VoucherRow = {
  id: string;
  tenantId: string;
  promoId: string | null;
  code: string;
  discountType: string;
  discountValue: string;
  memberId: string | null;
  expiresAt: string | null;
  status: "active" | "redeemed" | "cancelled";
  cancelReason: string | null;
  cancelledAt: string | null;
  issuedByUserId: string | null;
  redeemedAgainstSaleId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function statusBadgeVariant(status: string) {
  if (status === "active") return "success";
  if (status === "redeemed") return "secondary";
  if (status === "cancelled") return "destructive";
  return "default";
}

export default function VouchersPage() {
  const query = useListQuery();
  const [vouchers, setVouchers] = useState<VoucherRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const status = query.filters.status as "active" | "redeemed" | "cancelled" | undefined;
  const setStatus = (v: string) => query.setFilters({ ...query.filters, status: v || undefined });

  const loadVouchers = useCallback(async () => {
    const res = await api.rpc.vouchers.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
        code: query.q || undefined,
        status,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setVouchers(body.items as VoucherRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order, query.q, status]);

  useEffect(() => {
    loadVouchers();
  }, [loadVouchers]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  // Issue Dialog
  const [issueOpen, setIssueOpen] = useState(false);
  const [discountType, setDiscountType] = useState<"percentage" | "fixed_amount">("percentage");
  const [discountValue, setDiscountValue] = useState("");
  const [memberId, setMemberId] = useState("");
  const [promoId, setPromoId] = useState("");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [savingIssue, setSavingIssue] = useState(false);

  function openIssue() {
    setDiscountType("percentage");
    setDiscountValue("");
    setMemberId("");
    setPromoId("");
    setCode("");
    setExpiresAt("");
    setIssueOpen(true);
  }

  function closeIssue() {
    setIssueOpen(false);
  }

  async function submitIssue(e: React.FormEvent) {
    e.preventDefault();
    setSavingIssue(true);

    const parsedValue = discountType === "percentage" ? parseFloat(discountValue) : discountValue;

    try {
      const res = await api.rpc.vouchers.$post({
        json: {
          discountType,
          discountValue: parsedValue as number | string,
          memberId: memberId || undefined,
          promoId: promoId || undefined,
          code: code || undefined,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        }
      });
      if (res.ok) {
        toast.success("Voucher issued.");
        closeIssue();
        loadVouchers();
      } else {
        const message = await extractError(res, "Could not issue voucher.");
        toast.error(message);
      }
    } catch (e) {
      toast.error("An unexpected error occurred.");
    } finally {
      setSavingIssue(false);
    }
  }

  // Cancel Dialog
  const [cancelDialog, setCancelDialog] = useState<{ voucher: VoucherRow } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  function openCancel(voucher: VoucherRow) {
    setCancelDialog({ voucher });
    setCancelReason("");
  }

  function closeCancel() {
    setCancelDialog(null);
  }

  async function submitCancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelDialog) return;
    setCancelling(true);
    try {
      const res = await api.rpc.vouchers[":id"].cancel.$post({
        param: { id: cancelDialog.voucher.id },
        json: { reason: cancelReason || undefined },
      });
      if (res.ok) {
        toast.success("Voucher cancelled.");
        closeCancel();
        loadVouchers();
      } else {
        const message = await extractError(res, "Could not cancel voucher.");
        toast.error(message);
      }
    } catch (e) {
      toast.error("An unexpected error occurred.");
    } finally {
      setCancelling(false);
    }
  }

  const renderActions = (voucher: VoucherRow) => (
    <Row shrink items="center">
      <Can permissions={me?.permissions} resource="voucher" action="manage">
        {voucher.status === "active" ? (
          <Button variant="outline" size="sm" onClick={() => openCancel(voucher)}>
            Cancel
          </Button>
        ) : null}
      </Can>
    </Row>
  );

  const columns: DataTableColumn<VoucherRow>[] = [
    { key: "code", header: "Code", sortable: true },
    {
      key: "discount",
      header: "Discount",
      sortable: false,
      render: (row) =>
        row.discountType === "percentage"
          ? `${row.discountValue}%`
          : row.discountValue,
    },
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
    { key: "memberId", header: "Member", sortable: false, render: (row) => row.memberId ?? "—" },
    {
      key: "expiresAt",
      header: "Expires",
      sortable: true,
      render: (row) => (row.expiresAt ? new Date(row.expiresAt).toLocaleString() : "—"),
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
      <Row items="center" justify="between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Vouchers</h1>
          <p className="text-sm text-muted-foreground">
            Manage discount vouchers and promo codes.
          </p>
        </div>
        <Can permissions={me?.permissions} resource="voucher" action="manage">
          <Button onClick={openIssue}>Issue Voucher</Button>
        </Can>
      </Row>

      <Row items="center" justify="between">
        <DataTableToolbar
          q={query.q}
          onQChange={query.setQ}
          searchPlaceholder="Search codes…"
          view={query.view}
          onViewChange={query.setView}
        />
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="redeemed">Redeemed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      {query.view === "grid" ? (
        <DataTableGrid
          rows={vouchers}
          rowKey={(row) => row.id}
          emptyMessage="No vouchers yet."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.code}</p>
                <p className="text-sm">
                  {row.discountType === "percentage"
                    ? `${row.discountValue}%`
                    : row.discountValue}
                </p>
                <p className="text-sm mt-1">
                  <Badge variant={statusBadgeVariant(row.status)} className="capitalize">
                    {row.status}
                  </Badge>
                </p>
              </div>
              {renderActions(row)}
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={vouchers}
          rowKey={(row) => row.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No vouchers yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      {/* Issue Dialog */}
      <Dialog open={issueOpen} onOpenChange={(open) => !open && closeIssue()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue Voucher</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitIssue} className="space-y-4">
            <div className="space-y-2">
              <Label>Discount Type</Label>
              <Select
                value={discountType}
                onValueChange={(v) => setDiscountType(v as "percentage" | "fixed_amount")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage</SelectItem>
                  <SelectItem value="fixed_amount">Fixed Amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="discountValue">Discount Value</Label>
              <Input
                id="discountValue"
                inputMode="decimal"
                placeholder={discountType === "percentage" ? "10" : "10.00"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">Code (optional)</Label>
              <Input
                id="code"
                placeholder="Auto-generated if empty"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="memberId">Member ID (optional)</Label>
              <Input
                id="memberId"
                placeholder="Restrict to a specific member"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="promoId">Promo ID (optional)</Label>
              <Input
                id="promoId"
                placeholder="Link to a promotion"
                value={promoId}
                onChange={(e) => setPromoId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expiresAt">Expires At (optional)</Label>
              <DateTimeInput
                id="expiresAt"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeIssue}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingIssue}>
                {savingIssue ? "Saving…" : "Issue"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={!!cancelDialog} onOpenChange={(open) => !open && closeCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Voucher</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitCancel} className="space-y-4">
            <p className="text-sm">
              Are you sure you want to cancel voucher <strong>{cancelDialog?.voucher.code}</strong>?
            </p>
            <div className="space-y-2">
              <Label htmlFor="cancelReason">Reason (optional)</Label>
              <Textarea
                id="cancelReason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeCancel}>
                Back
              </Button>
              <Button type="submit" variant="destructive" disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel Voucher"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
