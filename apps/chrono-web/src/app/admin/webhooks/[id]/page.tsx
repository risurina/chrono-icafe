"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
  Stack,
  DataTable,
  DataTablePagination,
  useListQuery,
  Can,
  toast,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformWebhookDelivery,
  PaginationMeta,
  WebhookDeliveryStatus,
} from "agora";
import { usePlatformPermissions } from "../../layout";

const STATUS_VARIANT: Record<
  WebhookDeliveryStatus,
  "success" | "secondary" | "warning"
> = {
  success: "success",
  pending: "secondary",
  failed: "warning",
};

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Per-endpoint webhook delivery log (spec #16). Server-paginated; a failed
 * delivery can be retried (permission-gated `platformWebhook:retry`). Retrying
 * resets the attempt budget and re-enqueues; the delivery worker re-validates
 * the URL (SSRF) and re-signs at send-time. A disabled endpoint refuses the
 * retry server-side.
 */
export default function WebhookDeliveriesPage() {
  const permissions = usePlatformPermissions();
  const params = useParams<{ id: string }>();
  const endpointId = params.id;
  const query = useListQuery();
  const [items, setItems] = useState<PlatformWebhookDelivery[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [confirm, setConfirm] = useState<PlatformWebhookDelivery | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await adminApi["rpc-admin"].webhooks[":id"].deliveries.$get({
      param: { id: endpointId },
      query: { page: String(query.page), pageSize: String(query.pageSize) },
    });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if ((res.status as number) === 404) {
      setNotFound(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as PlatformWebhookDelivery[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [endpointId, query.page, query.pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitRetry() {
    if (!confirm) return;
    setSaving(true);
    const res = await adminApi["rpc-admin"].webhooks[":id"].deliveries[
      ":deliveryId"
    ].retry.$post({ param: { id: endpointId, deliveryId: confirm.id } });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not retry this delivery.");
      setConfirm(null);
      return;
    }
    toast.success(`Re-enqueued delivery ${confirm.id}.`);
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

  if (notFound) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              This webhook endpoint no longer exists.{" "}
              <Link href="/admin/webhooks" className="underline">
                Back to webhooks
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformWebhookDelivery>[] = [
    {
      key: "event",
      header: "Event",
      render: (r) => <span className="font-mono text-xs">{r.event}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>,
    },
    {
      key: "attempts",
      header: "Attempts",
      render: (r) => <span className="text-sm">{r.attempts}</span>,
    },
    {
      key: "responseCode",
      header: "Code",
      render: (r) => (
        <span className="text-sm text-muted-foreground">{r.responseCode ?? "—"}</span>
      ),
    },
    {
      key: "lastError",
      header: "Last error",
      render: (r) => (
        <span className="text-xs text-muted-foreground break-all">
          {r.lastError ?? "—"}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.createdAt)}</span>,
    },
    {
      key: "deliveredAt",
      header: "Delivered",
      render: (r) => (
        <span className="text-sm text-muted-foreground">{date(r.deliveredAt)}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) =>
        r.status === "failed" ? (
          <Can permissions={permissions} resource="platformWebhook" action="retry">
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirm(r);
                }}
              >
                Retry
              </Button>
            </div>
          </Can>
        ) : null,
    },
  ];

  return (
    <Stack>
      <div>
        <Link href="/admin/webhooks" className="text-sm underline">
          ← Webhooks
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Delivery log</h1>
        <p className="text-sm text-muted-foreground">
          Every delivery attempt for this endpoint. Retry a failed delivery to grant
          it a fresh attempt budget and re-enqueue it.
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="No deliveries recorded for this endpoint yet."
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
            <DialogTitle>Retry delivery</DialogTitle>
            <DialogDescription>
              Re-enqueue this failed delivery. It is re-signed and re-validated when
              the worker sends it. If the endpoint is disabled, re-enable it first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitRetry} disabled={saving}>
              Retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
