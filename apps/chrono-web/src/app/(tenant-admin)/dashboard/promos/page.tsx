"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Button,
  Input,
  Label,
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

type PromoStatus = "active" | "paused" | "archived";
type PromoDiscountType = "percentage" | "fixed_amount";

type Branch = { id: string; name: string };

type PromoRow = {
  id: string;
  tenantId: string;
  branchId: string | null;
  name: string;
  code: string | null;
  description: string | null;
  status: PromoStatus;
  discountType: PromoDiscountType;
  discountValue: string;
  minSpend: string | null;
  startsAt: string | null;
  endsAt: string;
  maxRedemptions: number | null;
  maxRedemptionsPerMember: number | null;
  createdAt: string;
  updatedAt: string;
};

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

type FormState = {
  branchId: string;
  name: string;
  requiresCode: boolean;
  code: string;
  description: string;
  discountType: PromoDiscountType;
  discountValue: string;
  minSpend: string;
  startsAt: string;
  endsAt: string;
  maxRedemptions: string;
  maxRedemptionsPerMember: string;
};

function emptyForm(): FormState {
  return {
    branchId: "",
    name: "",
    requiresCode: false,
    code: "",
    description: "",
    discountType: "percentage",
    discountValue: "",
    minSpend: "",
    startsAt: "",
    endsAt: "",
    maxRedemptions: "",
    maxRedemptionsPerMember: "",
  };
}

function formFromRow(row: PromoRow): FormState {
  return {
    branchId: row.branchId ?? "",
    name: row.name,
    requiresCode: !!row.code,
    code: row.code ?? "",
    description: row.description ?? "",
    discountType: row.discountType,
    discountValue: row.discountValue,
    minSpend: row.minSpend ?? "",
    startsAt: row.startsAt ?? "",
    endsAt: row.endsAt ?? "",
    maxRedemptions: row.maxRedemptions != null ? String(row.maxRedemptions) : "",
    maxRedemptionsPerMember:
      row.maxRedemptionsPerMember != null ? String(row.maxRedemptionsPerMember) : "",
  };
}

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function statusBadgeVariant(status: PromoStatus) {
  if (status === "active") return "success";
  if (status === "paused") return "secondary";
  if (status === "archived") return "destructive";
  return "default";
}

export default function PromosPage() {
  const query = useListQuery();
  const [promos, setPromos] = useState<PromoRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);

  const status = query.filters.status as PromoStatus | undefined;
  const setStatus = (v: string) => query.setFilters({ ...query.filters, status: v || undefined });

  const loadPromos = useCallback(async () => {
    const res = await api.rpc.promos.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
        status,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setPromos(body.items as PromoRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order, status]);

  useEffect(() => {
    loadPromos();
  }, [loadPromos]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.branches.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setBranches(body.items as Branch[]);
      }
    })();
  }, []);

  // Create/Edit Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PromoRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(row: PromoRow) {
    setEditing(row);
    setForm(formFromRow(row));
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
  }

  function buildPayload() {
    return {
      branchId: form.branchId || undefined,
      name: form.name,
      code: form.requiresCode ? form.code || undefined : undefined,
      description: form.description || undefined,
      discountType: form.discountType,
      discountValue: form.discountValue,
      minSpend: form.minSpend || undefined,
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined,
      endsAt: new Date(form.endsAt).toISOString(),
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
      maxRedemptionsPerMember: form.maxRedemptionsPerMember
        ? Number(form.maxRedemptionsPerMember)
        : undefined,
    };
  }

  async function submitDialog(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = buildPayload();
      const res = editing
        ? await api.rpc.promos[":id"].$patch({
            param: { id: editing.id },
            json: payload,
          })
        : await api.rpc.promos.$post({ json: payload });

      if (res.ok) {
        toast.success(editing ? "Promo updated." : "Promo created.");
        closeDialog();
        loadPromos();
      } else {
        const message = await extractError(res, "Could not save promo.");
        toast.error(message);
      }
    } catch {
      toast.error("An unexpected error occurred.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(row: PromoRow, next: PromoStatus) {
    try {
      const res = await api.rpc.promos[":id"].status.$post({
        param: { id: row.id },
        json: { status: next },
      });
      if (res.ok) {
        toast.success(`Promo ${next}.`);
        loadPromos();
      } else {
        const message = await extractError(res, "Could not update promo status.");
        toast.error(message);
      }
    } catch {
      toast.error("An unexpected error occurred.");
    }
  }

  const renderActions = (row: PromoRow) => (
    <Row shrink items="center">
      <Can permissions={me?.permissions} resource="promo" action="manage">
        {row.status !== "archived" ? (
          <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
            Edit
          </Button>
        ) : null}
        {row.status === "active" ? (
          <Button variant="outline" size="sm" onClick={() => changeStatus(row, "paused")}>
            Pause
          </Button>
        ) : null}
        {row.status === "paused" ? (
          <Button variant="outline" size="sm" onClick={() => changeStatus(row, "active")}>
            Resume
          </Button>
        ) : null}
        {row.status !== "archived" ? (
          <Button variant="outline" size="sm" onClick={() => changeStatus(row, "archived")}>
            Archive
          </Button>
        ) : null}
      </Can>
    </Row>
  );

  const columns: DataTableColumn<PromoRow>[] = [
    { key: "name", header: "Name", sortable: true },
    { key: "code", header: "Code", sortable: false, render: (row) => row.code ?? "Auto-apply" },
    {
      key: "discount",
      header: "Discount",
      sortable: false,
      render: (row) =>
        row.discountType === "percentage" ? `${row.discountValue}%` : row.discountValue,
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
    {
      key: "window",
      header: "Window",
      sortable: false,
      render: (row) =>
        `${row.startsAt ? new Date(row.startsAt).toLocaleDateString() : "Now"} – ${new Date(
          row.endsAt,
        ).toLocaleDateString()}`,
    },
    {
      key: "redemptions",
      header: "Redemptions",
      sortable: false,
      render: (row) => (row.maxRedemptions != null ? `Up to ${row.maxRedemptions}` : "Unlimited"),
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack gap={8}>
      <Row items="center" justify="between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Promos</h1>
          <p className="text-sm text-muted-foreground">
            Manage time-bounded pricing campaigns and coupon codes.
          </p>
        </div>
        <Can permissions={me?.permissions} resource="promo" action="manage">
          <Button onClick={openCreate}>New Promo</Button>
        </Can>
      </Row>

      <Row items="center" justify="between">
        <DataTableToolbar
          q={query.q}
          onQChange={query.setQ}
          searchPlaceholder="Search promos…"
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
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      {query.view === "grid" ? (
        <DataTableGrid
          rows={promos}
          rowKey={(row) => row.id}
          emptyMessage="No promos yet."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="text-sm text-muted-foreground">{row.code ?? "Auto-apply"}</p>
                <p className="text-sm">
                  {row.discountType === "percentage" ? `${row.discountValue}%` : row.discountValue}
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
          rows={promos}
          rowKey={(row) => row.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No promos yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Promo" : "New Promo"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitDialog} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 col-span-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label>Branch (optional — tenant-wide when unset)</Label>
                <Select
                  value={form.branchId || "all"}
                  onValueChange={(v) => setForm({ ...form, branchId: v === "all" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All branches</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Row items="center" gap={2} className="col-span-2">
                <input
                  id="requiresCode"
                  type="checkbox"
                  checked={form.requiresCode}
                  onChange={(e) => setForm({ ...form, requiresCode: e.target.checked })}
                />
                <Label htmlFor="requiresCode">Requires a coupon code</Label>
              </Row>
              {form.requiresCode ? (
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    placeholder="WELCOME10"
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>Discount Type</Label>
                <Select
                  value={form.discountType}
                  onValueChange={(v) => setForm({ ...form, discountType: v as PromoDiscountType })}
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
                  placeholder={form.discountType === "percentage" ? "10" : "10.00"}
                  value={form.discountValue}
                  onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="minSpend">Minimum Spend (optional)</Label>
                <Input
                  id="minSpend"
                  inputMode="decimal"
                  value={form.minSpend}
                  onChange={(e) => setForm({ ...form, minSpend: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="startsAt">Starts At (optional)</Label>
                <DateTimeInput
                  id="startsAt"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endsAt">Ends At</Label>
                <DateTimeInput
                  id="endsAt"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxRedemptions">Max Redemptions (optional)</Label>
                <Input
                  id="maxRedemptions"
                  inputMode="numeric"
                  value={form.maxRedemptions}
                  onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxRedemptionsPerMember">Max Redemptions Per Member (optional)</Label>
                <Input
                  id="maxRedemptionsPerMember"
                  inputMode="numeric"
                  value={form.maxRedemptionsPerMember}
                  onChange={(e) => setForm({ ...form, maxRedemptionsPerMember: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
