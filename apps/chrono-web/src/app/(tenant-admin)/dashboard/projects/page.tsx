"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import {
  Button,
  Input,
  Stack,
  Row,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  toast,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { Project, PaginationMeta } from "agora";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const query = useListQuery();

  const load = useCallback(async () => {
    const res = await api.rpc.projects.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setProjects(body.items as Project[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    const res = await api.rpc.projects.$post({ json: { name: name.trim() } });
    setLoading(false);
    if (!res.ok) {
      toast.error("Could not create project.");
      return;
    }
    setName("");
    load();
  }

  async function remove(id: string) {
    setConfirmingId(null);
    const res = await api.rpc.projects[":id"].$delete({ param: { id } });
    if (res.ok) load();
    else if ((res.status as number) === 403)
      toast.error("Only admins can delete projects.");
  }

  function renderActions(p: Project) {
    return confirmingId === p.id ? (
      <Row items="center">
        <span className="text-xs text-muted-foreground">Delete?</span>
        <Button variant="destructive" size="sm" onClick={() => remove(p.id)}>
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel delete"
          onClick={() => setConfirmingId(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </Row>
    ) : (
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${p.name}`}
        onClick={() => setConfirmingId(p.id)}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    );
  }

  const columns: DataTableColumn<Project>[] = [
    { key: "name", header: "Name", sortable: true },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (p) => new Date(p.createdAt).toLocaleString(),
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          The example tenant-scoped resource. Copy this pattern for your own.
        </p>
      </div>

      <form onSubmit={create} className="flex gap-2">
        <Input
          placeholder="New project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Adding…" : "Add"}
        </Button>
      </form>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search projects…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={projects}
          rowKey={(p) => p.id}
          emptyMessage="No projects yet."
          renderCard={(p) => (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(p.createdAt).toLocaleString()}
                </p>
              </div>
              {renderActions(p)}
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={projects}
          rowKey={(p) => p.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No projects yet."
        />
      )}

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
