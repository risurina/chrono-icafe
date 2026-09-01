"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  Can,
  toast,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformWebhookSummary, PaginationMeta } from "agora";
import { usePlatformPermissions } from "../layout";

const FILTER_KEYS = ["status"];

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Platform Webhooks (spec #16) — a cross-tenant view of every tenant's webhook
 * endpoints with the delivery rollup, plus incident actions (disable, and Retry
 * from the per-endpoint delivery log). The signing secret is NEVER shown.
 * Endpoints are created by tenants in their own settings. The permission gate is
 * enforced server-side; these controls are visibility-only (`Can`).
 */
export default function WebhooksPage() {
  const permissions = usePlatformPermissions();
  const router = useRouter();
  const query = useListQuery(FILTER_KEYS);
  const [items, setItems] = useState<PlatformWebhookSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [confirm, setConfirm] = useState<PlatformWebhookSummary | null>(null);
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
    const res = await adminApi["rpc-admin"].webhooks.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as PlatformWebhookSummary[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitDisable() {
    if (!confirm) return;
    setSaving(true);
    const res = await adminApi["rpc-admin"].webhooks[":id"].disable.$post({
      param: { id: confirm.id },
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not disable this endpoint.");
      return;
    }
    toast.success(`Disabled ${confirm.url} (${confirm.tenantName}).`);
    setConfirm(null);
    load();
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Webhooks are available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformWebhookSummary>[] = [
    {
      key: "url",
      header: "Endpoint",
      sortable: true,
      render: (r) => (
        <Link
          href={`/admin/webhooks/${r.id}`}
          className="font-mono text-xs underline break-all"
        >
          {r.url}
        </Link>
      ),
    },
    {
      key: "tenantName",
      header: "Tenant",
      sortable: true,
      render: (r) => <span className="text-sm">{r.tenantName}</span>,
    },
    {
      key: "events",
      header: "Events",
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.events.length > 0 ? r.events.join(", ") : "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div className="flex items-center gap-2">
          <Badge variant={r.enabled ? "success" : "outline"}>
            {r.enabled ? "Enabled" : "Disabled"}
          </Badge>
          {r.consecutiveFailures > 0 ? (
            <Badge variant="warning">{r.consecutiveFailures} fail(s)</Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: "lastDeliveryAt",
      header: "Last delivery",
      render: (r) => (
        <span className="text-sm text-muted-foreground">{date(r.lastDeliveryAt)}</span>
      ),
    },
    {
      key: "lastResponseCode",
      header: "Last code",
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.lastResponseCode ?? "—"}
          {r.pendingCount > 0 ? ` · ${r.pendingCount} pending` : ""}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/admin/webhooks/${r.id}`)}
          >
            Deliveries
          </Button>
          <Can permissions={permissions} resource="platformWebhook" action="disable">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={!r.enabled}
              onClick={() => {
                setConfirm(r);
              }}
            >
              Disable
            </Button>
          </Can>
        </div>
      ),
    },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="text-sm text-muted-foreground">
          Every tenant&apos;s webhook endpoints and their delivery health. Disable a
          runaway endpoint, or open its delivery log to retry a failed delivery. The
          signing secret is never shown.
        </p>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search endpoint URL or tenant"
        view={query.view}
        onViewChange={query.setView}
      >
        <Select
          value={query.filters.status ?? "all"}
          onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="No webhook endpoints across any tenant yet."
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

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable webhook endpoint</DialogTitle>
            <DialogDescription>
              {confirm
                ? `Stop delivering to ${confirm.url} (${confirm.tenantName}). Pending and future deliveries will not be sent until the tenant re-enables it.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={submitDisable} disabled={saving}>
              Disable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
