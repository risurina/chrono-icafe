"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Card,
  CardContent,
  Stack,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { AuditEvent, PaginationMeta } from "agora";

export default function AuditLogPage() {
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const query = useListQuery();

  const load = useCallback(async () => {
    setLoading(true);
    const q: Record<string, string> = {
      page: String(query.page),
      pageSize: String(query.pageSize),
    };
    if (query.q.trim()) q.action = query.q.trim();
    const res = await api.rpc.audit.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as AuditEvent[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q]);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              The audit log is available to admins and owners only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<AuditEvent>[] = [
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
      key: "actor",
      header: "Actor",
      render: (e) => (
        <span className="text-muted-foreground">
          {e.actorLabel ?? e.actorId ?? e.actorType}
        </span>
      ),
    },
    {
      key: "target",
      header: "Target",
      render: (e) => (
        <span className="text-muted-foreground">
          {e.targetLabel ?? e.targetId ?? e.targetType ?? "—"}
        </span>
      ),
    },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground">
          A record of who did what in this business.
        </p>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Filter by action (e.g. project.deleted)"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={items}
          rowKey={(e) => e.id}
          loading={loading}
          emptyMessage="No audit events yet."
          renderCard={(e) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Badge variant="secondary">{e.action}</Badge>
                <span className="text-xs text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Actor: {e.actorLabel ?? e.actorId ?? e.actorType}
              </p>
              <p className="text-sm text-muted-foreground">
                Target: {e.targetLabel ?? e.targetId ?? e.targetType ?? "—"}
              </p>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(e) => e.id}
          loading={loading}
          emptyMessage="No audit events yet."
        />
      )}

      {meta ? (
        <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} />
      ) : null}
    </Stack>
  );
}
