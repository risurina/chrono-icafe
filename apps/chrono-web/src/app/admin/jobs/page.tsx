"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Can,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stack,
  toast,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { usePlatformPermissions } from "../layout";
import type { PlatformJob, PaginationMeta } from "agora";

const FILTER_KEYS = ["queue", "status"];

// Sentinel for the "any" option of a Select filter — Radix Select cannot hold an
// empty-string value, so "any" maps to clearing the filter (undefined).
const ANY = "__any__";

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}

function statusVariant(status: PlatformJob["status"]) {
  if (status === "success") return "default" as const;
  if (status === "failed") return "destructive" as const;
  return "secondary" as const;
}

/**
 * Platform-wide job queue — every named queue's `job` rows (email, webhooks,
 * and any future queue), read-only. See `.ai/plans/agora/active/general-job-queue`.
 * Mirrors `admin/audit`'s DataTable/useListQuery stack (`.ai/rules/data-listing.md`).
 */
export default function PlatformJobQueuePage() {
  const permissions = usePlatformPermissions();
  const [items, setItems] = useState<PlatformJob[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [queues, setQueues] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [selected, setSelected] = useState<PlatformJob | null>(null);
  const [retryTarget, setRetryTarget] = useState<PlatformJob | null>(null);
  const [retryAllOpen, setRetryAllOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const query = useListQuery(FILTER_KEYS);

  const load = useCallback(async () => {
    setLoading(true);
    const q: Record<string, string> = {
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...query.filters,
    };
    const res = await adminApi["rpc-admin"].jobs.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as PlatformJob[]);
      setMeta(body.meta as PaginationMeta);
      setQueues(body.queues as string[]);
    }
  }, [query.page, query.pageSize, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitRetry() {
    if (!retryTarget) return;
    setRetrying(true);
    const res = await adminApi["rpc-admin"].jobs[":id"].retry.$post({
      param: { id: retryTarget.id },
    });
    setRetrying(false);
    setRetryTarget(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not retry this job.");
      return;
    }
    toast.success("Job re-enqueued.");
    load();
  }

  async function submitRetryAll() {
    const q = query.filters.queue;
    if (!q) return;
    setRetrying(true);
    const res = await adminApi["rpc-admin"].jobs.retry.$post({ json: { queue: q } });
    setRetrying(false);
    setRetryAllOpen(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not retry these jobs.");
      return;
    }
    const body = await res.json();
    toast.success(`Re-enqueued ${body.retried} job${body.retried === 1 ? "" : "s"}.`);
    load();
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              The job queue is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const resultSummary = (j: PlatformJob) =>
    j.result && Object.keys(j.result).length > 0
      ? Object.entries(j.result)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "—";

  const columns: DataTableColumn<PlatformJob>[] = [
    {
      key: "queue",
      header: "Queue",
      render: (j) => <Badge variant="outline">{j.queue}</Badge>,
    },
    {
      key: "type",
      header: "Type",
      render: (j) => <span className="text-muted-foreground">{j.type}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (j) => <Badge variant={statusVariant(j.status)}>{j.status}</Badge>,
    },
    {
      key: "attempts",
      header: "Attempts",
      render: (j) => (
        <span className="text-muted-foreground">
          {j.attempts} / {j.maxAttempts}
        </span>
      ),
    },
    {
      key: "tenant",
      header: "Tenant",
      render: (j) => (
        <span className="text-muted-foreground">{j.tenantName ?? j.tenantId ?? "—"}</span>
      ),
    },
    {
      key: "nextAttemptAt",
      header: "Next attempt",
      render: (j) =>
        j.status === "pending" ? (
          <span className="whitespace-nowrap text-muted-foreground">
            {new Date(j.nextAttemptAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (j) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {new Date(j.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "lastError",
      header: "Last error",
      render: (j) =>
        j.lastError ? (
          <span className="max-w-[240px] truncate text-destructive" title={j.lastError}>
            {j.lastError}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "details",
      header: "",
      render: (j) => (
        <div className="flex justify-end gap-1">
          {j.status === "failed" ? (
            <Can permissions={permissions} resource="queue" action="retry">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setRetryTarget(j)}
              >
                Retry
              </Button>
            </Can>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setSelected(j)}
          >
            Details
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Stack>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Job queue</h1>
          <p className="text-sm text-muted-foreground">
            Every named queue&apos;s background jobs (email retries, webhook
            deliveries, and any future queue), across every tenant.
          </p>
        </div>
        <Can permissions={permissions} resource="queue" action="retry">
          <Button
            type="button"
            variant="outline"
            disabled={!query.filters.queue}
            title={
              query.filters.queue
                ? undefined
                : "Select a queue filter first — retrying every failed job across every queue at once is not allowed."
            }
            onClick={() => setRetryAllOpen(true)}
          >
            Retry all failed{query.filters.queue ? ` (${query.filters.queue})` : ""}
          </Button>
        </Can>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder=""
        view={query.view}
        onViewChange={query.setView}
      >
        <Select
          value={query.filters.queue ?? ANY}
          onValueChange={(v) => query.setFilters({ queue: v === ANY ? undefined : v })}
        >
          <SelectTrigger className="w-[140px]" aria-label="Queue">
            <SelectValue placeholder="Any queue" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any queue</SelectItem>
            {queues.map((q) => (
              <SelectItem key={q} value={q}>
                {q}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.filters.status ?? ANY}
          onValueChange={(v) => query.setFilters({ status: v === ANY ? undefined : v })}
        >
          <SelectTrigger className="w-[140px]" aria-label="Status">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            <SelectItem value="pending">pending</SelectItem>
            <SelectItem value="success">success</SelectItem>
            <SelectItem value="failed">failed</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      {query.view === "grid" ? (
        <DataTableGrid
          rows={items}
          rowKey={(j) => j.id}
          loading={loading}
          emptyMessage="No jobs yet."
          renderCard={(j) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Badge variant="outline">{j.queue}</Badge>
                <Badge variant={statusVariant(j.status)}>{j.status}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{j.type}</p>
              <p className="text-sm text-muted-foreground">
                Attempts: {j.attempts} / {j.maxAttempts}
              </p>
              <p className="text-sm text-muted-foreground">
                Tenant: {j.tenantName ?? j.tenantId ?? "—"}
              </p>
              <div className="-ml-2 flex items-center gap-1">
                {j.status === "failed" ? (
                  <Can permissions={permissions} resource="queue" action="retry">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setRetryTarget(j)}
                    >
                      Retry
                    </Button>
                  </Can>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setSelected(j)}
                >
                  Details
                </Button>
              </div>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(j) => j.id}
          loading={loading}
          emptyMessage="No jobs yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Job detail</DialogTitle>
            <DialogDescription>
              {selected ? new Date(selected.createdAt).toLocaleString() : ""}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <Stack gap={2}>
              <DetailRow label="ID" value={selected.id} />
              <DetailRow label="Queue" value={selected.queue} />
              <DetailRow label="Type" value={selected.type} />
              <DetailRow
                label="Status"
                value={<Badge variant={statusVariant(selected.status)}>{selected.status}</Badge>}
              />
              <DetailRow
                label="Attempts"
                value={`${selected.attempts} / ${selected.maxAttempts}`}
              />
              <DetailRow label="Tenant" value={selected.tenantName ?? selected.tenantId ?? "—"} />
              <DetailRow
                label="Next attempt"
                value={
                  selected.status === "pending"
                    ? new Date(selected.nextAttemptAt).toLocaleString()
                    : "—"
                }
              />
              <DetailRow label="Last updated" value={new Date(selected.updatedAt).toLocaleString()} />
              <DetailRow label="Last error" value={selected.lastError ?? "—"} />
              <DetailRow label="Result" value={resultSummary(selected)} />
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={retryTarget !== null} onOpenChange={(open) => !open && setRetryTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Retry this job?</DialogTitle>
            <DialogDescription>
              {retryTarget
                ? `Resets attempts to 0 and re-enqueues the "${retryTarget.type}" job on the "${retryTarget.queue}" queue. It will pick up the full provider chain again on the next tick.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRetryTarget(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={submitRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={retryAllOpen} onOpenChange={setRetryAllOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Retry all failed jobs?</DialogTitle>
            <DialogDescription>
              Resets attempts to 0 and re-enqueues every failed job on the
              &quot;{query.filters.queue}&quot; queue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRetryAllOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={submitRetryAll} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
