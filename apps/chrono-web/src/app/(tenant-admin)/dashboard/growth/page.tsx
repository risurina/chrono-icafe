"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Stack,
  DataTable,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type LeadRow = {
  businessName: string;
  city: string | null;
  message: string | null;
  createdAt: string;
};

/**
 * Lead-detail console: the actual business-name variant, city, and message a
 * player typed when they asked for this business on `/discover`, before it
 * joined Chrono. `growth:read` is admin+ only — a non-admin staff member
 * never reaches this page's link on `DemandBanner`, and the route itself
 * 403s if they navigate here directly.
 *
 * Server-paginated per `.ai/rules/data-listing.md` (the leads count can grow
 * unbounded) — no search/sort beyond `createdAt desc`, since the API route
 * itself only supports that one sort key.
 */
export default function GrowthLeadsPage() {
  const query = useListQuery();
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const res = await api.rpc.growth.leads.$get({
      query: { page: String(query.page), pageSize: String(query.pageSize) },
    });
    if (res.status === 403) {
      setForbidden(true);
      setRows([]);
      setMeta(null);
      return;
    }
    if (!res.ok) return;
    const body = await res.json();
    setRows(body.items as LeadRow[]);
    setMeta(body.meta as PaginationMeta);
  }, [query.page, query.pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: DataTableColumn<LeadRow>[] = [
    { key: "businessName", header: "Requested as", render: (r) => r.businessName },
    { key: "city", header: "City", render: (r) => r.city ?? "—" },
    { key: "message", header: "Message", render: (r) => r.message ?? "—" },
    {
      key: "createdAt",
      header: "Requested",
      render: (r) => new Date(r.createdAt).toLocaleString(),
    },
  ];

  if (forbidden) {
    return (
      <Stack gap={2}>
        <h1 className="text-2xl font-semibold tracking-tight">Player requests</h1>
        <p className="text-sm text-muted-foreground">
          Only admins can view player requests.
        </p>
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Player requests</h1>
        <p className="text-sm text-muted-foreground">
          Players who searched for your business on Chrono&apos;s public discovery
          page before you joined.
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.businessName}|${r.city ?? ""}|${r.createdAt}`}
        emptyMessage="No player requests recorded."
      />
      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}
    </Stack>
  );
}
