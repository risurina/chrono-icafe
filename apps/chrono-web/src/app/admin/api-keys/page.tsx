"use client";

import { useCallback, useEffect, useState } from "react";
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
  toast,
  Input,
  Row,
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
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformApiKeySummary,
  PaginationMeta,
  ApiKeyCreated,
} from "agora";
import { usePlatformPermissions } from "../layout";

const FILTER_KEYS = ["status"];

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

type ActionKind = "revoke" | "rotate";

/**
 * Platform API Keys (spec #16) — a cross-tenant view of every tenant's API keys
 * with incident actions (revoke / rotate). The full secret is NEVER shown for an
 * existing key; a rotation reveals the NEW secret exactly once in a dialog. Keys
 * are created on the tenant's own settings page, never here. Server enforces the
 * permission gate; the controls here are visibility-only (`Can`).
 */
export default function ApiKeysPage() {
  const permissions = usePlatformPermissions();
  const query = useListQuery(FILTER_KEYS);
  const [items, setItems] = useState<PlatformApiKeySummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [confirm, setConfirm] = useState<{
    kind: ActionKind;
    row: PlatformApiKeySummary;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // The new secret from a rotation — shown exactly once, then discarded.
  const [rotated, setRotated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);

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
    const res = await adminApi["rpc-admin"]["api-keys"].$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as PlatformApiKeySummary[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  function openConfirm(kind: ActionKind, row: PlatformApiKeySummary) {
    setConfirm({ kind, row });
  }

  async function submit() {
    if (!confirm) return;
    const { kind, row } = confirm;
    setSaving(true);
    const param = { id: row.id };
    if (kind === "revoke") {
      const res = await adminApi["rpc-admin"]["api-keys"][":id"].revoke.$post({ param });
      setSaving(false);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? "Could not revoke this key.");
        return;
      }
      setConfirm(null);
      toast.success(`Revoked "${row.name}" (${row.tenantName}).`);
      load();
      return;
    }
    // rotate
    const res = await adminApi["rpc-admin"]["api-keys"][":id"].rotate.$post({ param });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not rotate this key.");
      return;
    }
    const body = await res.json();
    setConfirm(null);
    setCopied(false);
    setRotated(body.apiKey as ApiKeyCreated);
    toast.success(`Rotated "${row.name}" (${row.tenantName}).`);
    load();
  }

  async function copySecret() {
    if (!rotated) return;
    try {
      await navigator.clipboard.writeText(rotated.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              API keys are available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformApiKeySummary>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      render: (r) => (
        <div className="space-y-1">
          <div className="text-sm font-medium">{r.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{r.prefix}…</div>
        </div>
      ),
    },
    {
      key: "tenantName",
      header: "Tenant",
      sortable: true,
      render: (r) => <span className="text-sm">{r.tenantName}</span>,
    },
    {
      key: "owner",
      header: "Owner",
      render: (r) => (
        <span className="text-sm text-muted-foreground">{r.ownerLabel ?? "—"}</span>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (r) => <Badge variant="secondary">{r.role}</Badge>,
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.createdAt)}</span>,
    },
    {
      key: "lastUsedAt",
      header: "Last used",
      sortable: true,
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.lastUsedAt)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={r.status === "active" ? "success" : "outline"}>
          {r.status === "active" ? "Active" : "Revoked"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Can permissions={permissions} resource="platformApiKey" action="rotate">
            <Button
              variant="outline"
              size="sm"
              disabled={r.status === "revoked"}
              onClick={() => openConfirm("rotate", r)}
            >
              Rotate
            </Button>
          </Can>
          <Can permissions={permissions} resource="platformApiKey" action="revoke">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={r.status === "revoked"}
              onClick={() => openConfirm("revoke", r)}
            >
              Revoke
            </Button>
          </Can>
        </div>
      ),
    },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Every tenant&apos;s API keys. Revoke a leaked key or rotate it to a fresh
          secret. Keys are created by tenants in their own business settings — the
          full secret is never shown here.
        </p>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search key name or tenant"
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
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="No API keys across any tenant yet."
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

      {/* Confirm dialog (revoke + rotate share it). */}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "rotate" ? "Rotate API key" : "Revoke API key"}
            </DialogTitle>
            <DialogDescription>
              {confirm
                ? confirm.kind === "rotate"
                  ? `Revoke "${confirm.row.name}" (${confirm.row.tenantName}) and mint a replacement. The old key stops working immediately and the new secret is shown once. The tenant is notified via the audit trail.`
                  : `Revoke "${confirm.row.name}" (${confirm.row.tenantName}). It stops authenticating immediately. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant={confirm?.kind === "revoke" ? "destructive" : "default"}
              onClick={submit}
              disabled={saving}
            >
              {confirm?.kind === "rotate" ? "Rotate" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time new-secret reveal after a rotation. */}
      <Dialog open={rotated !== null} onOpenChange={(open) => !open && setRotated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy the new API key</DialogTitle>
            <DialogDescription>
              This is the only time the full key is shown. Deliver it to the tenant
              securely — it cannot be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <Row>
            <Input readOnly value={rotated?.secret ?? ""} className="font-mono" />
            <Button type="button" variant="secondary" onClick={copySecret}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </Row>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
