"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  toast,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stack,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformAuditEvent, PaginationMeta } from "agora";

const FILTER_KEYS = [
  "action",
  "actorId",
  "actorRole",
  "result",
  "targetId",
  "targetType",
  "from",
  "to",
];

// Sentinel for the "any" option of a Select filter — Radix Select cannot hold an
// empty-string value, so "any" maps to clearing the filter (undefined).
const ANY = "__any__";

/** A single label/value row inside the detail dialog. */
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Render a readable before→after view of an event's `metadata`. Recognises the
 * common shapes the audit writers emit (`{previousRole, role}`, `{before, after}`)
 * and otherwise falls back to a plain key/value list so no event is opaque.
 * Metadata is rendered as TEXT only — never executed or trusted as HTML.
 */
function MetadataDetail({ metadata }: { metadata: PlatformAuditEvent["metadata"] }) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return <span className="text-sm text-muted-foreground">No additional detail.</span>;
  }
  const m = metadata as Record<string, unknown>;
  const fmt = (v: unknown) =>
    v === null || v === undefined
      ? "—"
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

  const diffs: { label: string; from: unknown; to: unknown }[] = [];
  if ("previousRole" in m || "role" in m) {
    diffs.push({ label: "Role", from: m.previousRole, to: m.role });
  }
  if ("before" in m || "after" in m) {
    diffs.push({ label: "Value", from: m.before, to: m.after });
  }
  const shown = new Set(["previousRole", "role", "before", "after"]);
  const rest = Object.entries(m).filter(([k]) => !shown.has(k));

  return (
    <Stack gap={2}>
      {diffs.map((d) => (
        <DetailRow
          key={d.label}
          label={d.label}
          value={
            <span>
              {fmt(d.from)} <span className="text-muted-foreground">→</span> {fmt(d.to)}
            </span>
          }
        />
      ))}
      {rest.map(([k, v]) => (
        <DetailRow key={k} label={k} value={fmt(v)} />
      ))}
    </Stack>
  );
}

/**
 * Platform-wide audit log — every mutating platform-admin action (org
 * suspend/resume, auth-provider toggle, staff role grant/revoke), regardless
 * of whether the action had a tenant. See .ai/rules/data-listing.md for the
 * shared DataTable/useListQuery stack this mirrors from `dashboard/audit`.
 */
export default function PlatformAuditLogPage() {
  const [items, setItems] = useState<PlatformAuditEvent[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<PlatformAuditEvent | null>(null);
  const query = useListQuery(FILTER_KEYS);

  const load = useCallback(async () => {
    setLoading(true);
    const q: Record<string, string> = {
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...query.filters,
    };
    if (query.q.trim()) q.q = query.q.trim();
    const res = await adminApi["rpc-admin"].audit.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as PlatformAuditEvent[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const q: Record<string, string> = { ...query.filters };
      if (query.q.trim()) q.q = query.q.trim();
      const res = await adminApi["rpc-admin"].audit.export.$get({ query: q });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message =
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : "Export failed.";
        toast.error(message);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const link = document.createElement("a");
      link.href = url;
      link.download = `platform-audit-${timestamp}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [query.filters, query.q]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              The platform audit log is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const targetCell = (e: PlatformAuditEvent) =>
    e.tenantLabel ?? e.targetLabel ?? e.targetId ?? e.targetType ?? "—";

  const columns: DataTableColumn<PlatformAuditEvent>[] = [
    {
      key: "createdAt",
      header: "When",
      render: (e) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {new Date(e.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (e) => <Badge variant="secondary">{e.action}</Badge>,
    },
    {
      key: "result",
      header: "Result",
      render: (e) => (
        <Badge variant={e.result === "failure" ? "destructive" : "default"}>
          {e.result}
        </Badge>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      render: (e) => (
        <span className="text-muted-foreground">{e.actorLabel ?? e.actorId ?? "—"}</span>
      ),
    },
    {
      key: "actorRole",
      header: "Role",
      render: (e) =>
        e.actorRole ? (
          <Badge variant="outline">{e.actorRole}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "target",
      header: "Target / Tenant",
      render: (e) => <span className="text-muted-foreground">{targetCell(e)}</span>,
    },
    {
      key: "details",
      header: "",
      render: (e) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setSelected(e)}
        >
          Details
        </Button>
      ),
    },
  ];

  // `from`/`to` are stored/sent as full ISO 8601 datetimes (the server schema
  // requires `z.string().datetime()`), but `Input type="date"` only edits the
  // date portion — round-trip through midnight UTC so a reload restores the
  // same date in the input.
  const fromDate = query.filters.from ? query.filters.from.slice(0, 10) : "";
  const toDate = query.filters.to ? query.filters.to.slice(0, 10) : "";

  return (
    <Stack>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Every mutating platform-admin action, across every tenant. Audit history
            starts from when this log was enabled — there is no historical backfill.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button type="button" variant="outline" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Filter by action or actor"
        view={query.view}
        onViewChange={query.setView}
      >
        <Input
          placeholder="Action contains…"
          value={query.filters.action ?? ""}
          onChange={(e) => query.setFilters({ action: e.target.value || undefined })}
          className="max-w-[160px]"
        />
        <Select
          value={query.filters.actorRole ?? ANY}
          onValueChange={(v) =>
            query.setFilters({ actorRole: v === ANY ? undefined : v })
          }
        >
          <SelectTrigger className="w-[140px]" aria-label="Actor role">
            <SelectValue placeholder="Any role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any role</SelectItem>
            <SelectItem value="viewer">viewer</SelectItem>
            <SelectItem value="support">support</SelectItem>
            <SelectItem value="admin">admin</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={query.filters.result ?? ANY}
          onValueChange={(v) =>
            query.setFilters({ result: v === ANY ? undefined : v })
          }
        >
          <SelectTrigger className="w-[140px]" aria-label="Result">
            <SelectValue placeholder="Any result" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any result</SelectItem>
            <SelectItem value="success">success</SelectItem>
            <SelectItem value="failure">failure</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Actor ID"
          value={query.filters.actorId ?? ""}
          onChange={(e) => query.setFilters({ actorId: e.target.value || undefined })}
          className="max-w-[160px]"
        />
        <Input
          placeholder="Target org ID"
          value={query.filters.targetId ?? ""}
          onChange={(e) =>
            query.setFilters({
              targetId: e.target.value || undefined,
              // Always sent together — never targetId alone — so the
              // existing (targetType, targetId, createdAt desc) index is used.
              targetType: e.target.value ? "organization" : undefined,
            })
          }
          className="max-w-[160px]"
        />
        <Input
          type="date"
          aria-label="From date"
          value={fromDate}
          onChange={(e) =>
            query.setFilters({
              from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
            })
          }
          className="max-w-[160px]"
        />
        <Input
          type="date"
          aria-label="To date"
          value={toDate}
          onChange={(e) =>
            query.setFilters({
              to: e.target.value
                ? new Date(`${e.target.value}T23:59:59.999Z`).toISOString()
                : undefined,
            })
          }
          className="max-w-[160px]"
        />
      </DataTableToolbar>

      {query.view === "grid" ? (
        <DataTableGrid
          rows={items}
          rowKey={(e) => e.id}
          loading={loading}
          emptyMessage="No platform audit events yet."
          renderCard={(e) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Badge variant="secondary">{e.action}</Badge>
                <span className="text-xs text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={e.result === "failure" ? "destructive" : "default"}>
                  {e.result}
                </Badge>
                {e.actorRole ? <Badge variant="outline">{e.actorRole}</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                Actor: {e.actorLabel ?? e.actorId ?? "—"}
              </p>
              <p className="text-sm text-muted-foreground">Target: {targetCell(e)}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(e)}
              >
                Details
              </Button>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(e) => e.id}
          loading={loading}
          emptyMessage="No platform audit events yet."
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
            <DialogTitle>Audit event</DialogTitle>
            <DialogDescription>
              {selected ? new Date(selected.createdAt).toLocaleString() : ""}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <Stack gap={4}>
              <Stack gap={2}>
                <DetailRow label="Action" value={selected.action} />
                <DetailRow
                  label="Result"
                  value={
                    <Badge
                      variant={selected.result === "failure" ? "destructive" : "default"}
                    >
                      {selected.result}
                    </Badge>
                  }
                />
                <DetailRow label="Actor" value={selected.actorLabel ?? selected.actorId ?? "—"} />
                <DetailRow label="Actor role" value={selected.actorRole ?? "—"} />
                <DetailRow
                  label="Target"
                  value={selected.targetLabel ?? selected.targetId ?? "—"}
                />
                <DetailRow label="Tenant" value={selected.tenantLabel ?? "—"} />
                <DetailRow label="Target type" value={selected.targetType ?? "—"} />
                <DetailRow label="IP" value={selected.ip ?? "—"} />
                <DetailRow label="User agent" value={selected.userAgent ?? "—"} />
              </Stack>
              <Stack gap={2}>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Change detail
                </span>
                <MetadataDetail metadata={selected.metadata} />
              </Stack>
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
