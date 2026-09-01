"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  Switch,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  Can,
  toast,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import {
  formatMoney,
  type PlatformTransactionRow,
  type PaginationMeta,
  type TransactionStatusDTO,
  type TransactionKindDTO,
} from "agora";
import { usePlatformPermissions } from "../layout";

const FILTER_KEYS = ["status", "kind", "provider"];

const STATUSES: TransactionStatusDTO[] = [
  "succeeded",
  "failed",
  "pending",
  "refund_pending",
  "refunded",
  "partially_refunded",
];

const KINDS: TransactionKindDTO[] = ["charge", "refund", "invoice"];

const STATUS_VARIANT: Record<
  TransactionStatusDTO,
  "success" | "secondary" | "outline" | "warning" | "destructive"
> = {
  succeeded: "success",
  failed: "destructive",
  pending: "secondary",
  refund_pending: "warning",
  refunded: "outline",
  partially_refunded: "warning",
};

const STATUS_LABEL: Record<TransactionStatusDTO, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  pending: "Pending",
  refund_pending: "Refund pending",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

function date(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Platform Payments / Transactions (spec #7) — the cross-tenant list of the
 * webhook-fed `payment_transaction` mirror. Reads gate on `billing:read`; the
 * per-row Refund action gates on `billing:refund` (admin-only) and is confirm-
 * guarded. Amounts are integer minor-unit strings formatted with `formatMoney`
 * — never parsed to a float for display math. The billing-disabled state is
 * explicit, never inferred from empty data.
 */
export default function TransactionsPage() {
  const permissions = usePlatformPermissions();
  const query = useListQuery(FILTER_KEYS);
  const [items, setItems] = useState<PlatformTransactionRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [refundRow, setRefundRow] = useState<PlatformTransactionRow | null>(null);
  const [partial, setPartial] = useState(false);
  const [amountMinor, setAmountMinor] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const q: Record<string, string> = {
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...query.filters,
    };
    if (query.q.trim()) q.q = query.q.trim();
    if (query.sort) {
      q.sort = query.sort;
      q.order = query.order;
    }
    const res = await adminApi["rpc-admin"].transactions.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setEnabled(body.enabled);
      if (body.enabled) {
        setItems(body.items as PlatformTransactionRow[]);
        setMeta(body.meta as PaginationMeta);
      }
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  function openRefund(row: PlatformTransactionRow) {
    setReason("");
    setPartial(false);
    setAmountMinor("");
    setRefundRow(row);
  }

  async function submitRefund() {
    if (!refundRow) return;
    setSaving(true);
    const json: { reason: string; amount?: string } = { reason };
    if (partial) json.amount = amountMinor.trim();
    const res = await adminApi["rpc-admin"].transactions[":id"].refund.$post({
      param: { id: refundRow.id },
      json,
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not process this refund.");
      return;
    }
    const tenant = refundRow.tenantName;
    setRefundRow(null);
    toast.success(
      `Refund submitted for ${tenant}. The transaction will show as refunded once the provider confirms it.`,
    );
    load();
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardHeader>
            <CardTitle>Restricted</CardTitle>
            <CardDescription>
              Transactions are available to platform staff only.
            </CardDescription>
          </CardHeader>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformTransactionRow>[] = [
    {
      key: "providerObjectId",
      header: "Transaction",
      render: (r) => (
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 font-mono text-xs"
            title="Copy transaction id"
            onClick={() => navigator.clipboard?.writeText(r.providerObjectId)}
          >
            {r.providerObjectId.length > 16
              ? `${r.providerObjectId.slice(0, 16)}…`
              : r.providerObjectId}
          </Button>
          <div className="text-xs text-muted-foreground capitalize">{r.kind}</div>
        </div>
      ),
    },
    {
      key: "tenantName",
      header: "Tenant",
      render: (r) => (
        <div className="space-y-1">
          <Link
            href={`/admin/organizations/${r.tenantId}`}
            className="text-sm font-medium underline"
          >
            {r.tenantName}
          </Link>
          <div className="text-xs text-muted-foreground">{r.tenantSlug}</div>
        </div>
      ),
    },
    {
      key: "customerLabel",
      header: "Customer",
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.customerLabel ?? "—"}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      sortable: true,
      render: (r) => (
        <div className="space-y-1">
          <span className="text-sm font-medium">{formatMoney(r.amount, r.currency)}</span>
          {r.refundedAmount !== "0" ? (
            <div className="text-xs text-muted-foreground">
              -{formatMoney(r.refundedAmount, r.currency)} refunded
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "method",
      header: "Method",
      render: (r) => <span className="text-sm text-muted-foreground">{r.method ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (r) => (
        <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      render: (r) => (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="capitalize">
            {r.provider}
          </Badge>
          {r.stripeDashboardUrl ? (
            <a
              href={r.stripeDashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs underline text-muted-foreground"
            >
              Stripe
            </a>
          ) : null}
        </div>
      ),
    },
    {
      key: "occurredAt",
      header: "Date",
      sortable: true,
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.occurredAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <Can permissions={permissions} resource="billing" action="refund">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={!r.refundable}
              title={
                r.refundable
                  ? "Refund this charge"
                  : "This transaction cannot be refunded (not a refundable Stripe charge)."
              }
              onClick={() => openRefund(r)}
            >
              Refund
            </Button>
          </div>
        </Can>
      ),
    },
  ];

  const remainingMinor = refundRow
    ? String(Number(refundRow.amount) - Number(refundRow.refundedAmount))
    : "0";
  const canSubmit =
    reason.trim().length > 0 &&
    (!partial || /^\d+$/.test(amountMinor.trim())) &&
    !saving;

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant payments, invoices and refunds mirrored from the payment
          provider. For the aggregate revenue rollup, see{" "}
          <Link href="/admin/billing" className="underline">
            Billing
          </Link>
          ; to manage plans and subscriptions, see{" "}
          <Link href="/admin/subscriptions" className="underline">
            Subscriptions
          </Link>
          .
        </p>
      </div>

      {enabled === false ? (
        <Card>
          <CardHeader>
            <CardTitle>Billing is not configured for this environment.</CardTitle>
            <CardDescription>
              No payment provider secret key is set, so transaction data cannot be
              read and no refund actions are offered. Configure billing to see
              payments here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {enabled ? (
        <>
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search tenant or transaction id"
            view={query.view}
            onViewChange={query.setView}
          >
            <Select
              value={query.filters.status ?? "all"}
              onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.filters.kind ?? "all"}
              onValueChange={(v) => query.setFilters({ kind: v === "all" ? undefined : v })}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k} className="capitalize">
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.filters.provider ?? "all"}
              onValueChange={(v) => query.setFilters({ provider: v === "all" ? undefined : v })}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                <SelectItem value="stripe">Stripe</SelectItem>
                <SelectItem value="xendit">Xendit</SelectItem>
              </SelectContent>
            </Select>
          </DataTableToolbar>

          <DataTable
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            loading={loading}
            emptyMessage="No transactions yet."
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
        </>
      ) : null}

      {/* Refund confirm dialog — names the tenant + amount and requires a reason. */}
      <Dialog open={refundRow !== null} onOpenChange={(open) => !open && setRefundRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {refundRow ? `Refund — ${refundRow.tenantName}` : ""}
            </DialogTitle>
            <DialogDescription>
              This issues a real refund against the payment provider. The
              transaction is finalized when the provider confirms the refund. The
              action is recorded in both the tenant and platform audit trails.
            </DialogDescription>
          </DialogHeader>

          {refundRow ? (
            <div className="space-y-4">
              <div className="text-sm">
                <div>
                  Charge total:{" "}
                  <span className="font-medium">
                    {formatMoney(refundRow.amount, refundRow.currency)}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  Refundable remaining:{" "}
                  {formatMoney(remainingMinor, refundRow.currency)}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Switch
                    id="partial-refund"
                    checked={partial}
                    onCheckedChange={setPartial}
                  />
                  <Label htmlFor="partial-refund">Partial refund</Label>
                </div>
                {partial ? (
                  <div className="space-y-1">
                    <Label htmlFor="refund-amount">
                      Amount in minor units (e.g. cents)
                    </Label>
                    <Input
                      id="refund-amount"
                      inputMode="numeric"
                      value={amountMinor}
                      onChange={(e) => setAmountMinor(e.target.value)}
                      placeholder={remainingMinor}
                    />
                    {/^\d+$/.test(amountMinor.trim()) ? (
                      <p className="text-xs text-muted-foreground">
                        ={" "}
                        {formatMoney(amountMinor.trim(), refundRow.currency)}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    A full refund of the remaining balance will be issued.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="refund-reason">Reason</Label>
                <Input
                  id="refund-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this refund being issued?"
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={submitRefund} disabled={!canSubmit}>
              Issue refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
