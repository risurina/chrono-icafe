"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  Badge,
  Stack,
  Row,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type BranchStatus = "active" | "disabled";

type Branch = {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  status: BranchStatus;
  address: string | null;
  contactNumber: string | null;
  email: string | null;
  timezone: string;
  latitude: string | null;
  longitude: string | null;
  operatingHours: string | null;
  googleMapsUrl: string | null;
  socialLinks: {
    facebook?: string | null;
    messenger?: string | null;
    instagram?: string | null;
    tiktok?: string | null;
    discord?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type FormState = {
  name: string;
  code: string;
  status: BranchStatus;
  address: string;
  contactNumber: string;
  email: string;
  timezone: string;
  latitude: string;
  longitude: string;
  operatingHours: string;
  googleMapsUrl: string;
  facebook: string;
  messenger: string;
  instagram: string;
  tiktok: string;
  discord: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  code: "",
  status: "active",
  address: "",
  contactNumber: "",
  email: "",
  timezone: "",
  latitude: "",
  longitude: "",
  operatingHours: "",
  googleMapsUrl: "",
  facebook: "",
  messenger: "",
  instagram: "",
  tiktok: "",
  discord: "",
};

function branchToForm(b: Branch): FormState {
  return {
    name: b.name,
    code: b.code,
    status: b.status,
    address: b.address ?? "",
    contactNumber: b.contactNumber ?? "",
    email: b.email ?? "",
    timezone: b.timezone ?? "",
    latitude: b.latitude ?? "",
    longitude: b.longitude ?? "",
    operatingHours: b.operatingHours ?? "",
    googleMapsUrl: b.googleMapsUrl ?? "",
    facebook: b.socialLinks?.facebook ?? "",
    messenger: b.socialLinks?.messenger ?? "",
    instagram: b.socialLinks?.instagram ?? "",
    tiktok: b.socialLinks?.tiktok ?? "",
    discord: b.socialLinks?.discord ?? "",
  };
}

function formToPayload(f: FormState) {
  const socialLinks = {
    facebook: f.facebook.trim() || undefined,
    messenger: f.messenger.trim() || undefined,
    instagram: f.instagram.trim() || undefined,
    tiktok: f.tiktok.trim() || undefined,
    discord: f.discord.trim() || undefined,
  };
  const hasSocialLinks = Object.values(socialLinks).some((v) => v !== undefined);
  return {
    name: f.name.trim(),
    code: f.code.trim() || undefined,
    status: f.status,
    address: f.address.trim() || undefined,
    contactNumber: f.contactNumber.trim() || undefined,
    email: f.email.trim() || undefined,
    timezone: f.timezone.trim() || undefined,
    latitude: f.latitude.trim() || undefined,
    longitude: f.longitude.trim() || undefined,
    operatingHours: f.operatingHours.trim() || undefined,
    googleMapsUrl: f.googleMapsUrl.trim() || undefined,
    socialLinks: hasSocialLinks ? socialLinks : undefined,
  };
}

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const query = useListQuery();

  const load = useCallback(async () => {
    const res = await api.rpc.branches.$get({
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
      setBranches(body.items as Branch[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(b: Branch) {
    setEditing(b);
    setForm(branchToForm(b));
    setDialogOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    const payload = formToPayload(form);
    const res = editing
      ? await api.rpc.branches[":id"].$patch({
          param: { id: editing.id },
          json: payload,
        })
      : await api.rpc.branches.$post({ json: payload });
    setSaving(false);
    if (!res.ok) {
      toast.error(
        (res.status as number) === 409
          ? "A branch with that code already exists."
          : (res.status as number) === 403
            ? "Only admins can manage branches."
            : editing
              ? "Could not update branch."
              : "Could not create branch.",
      );
      return;
    }
    toast.success(editing ? "Branch updated." : "Branch created.");
    setDialogOpen(false);
    load();
  }

  async function toggleStatus(b: Branch) {
    const nextStatus: BranchStatus = b.status === "active" ? "disabled" : "active";
    const res = await api.rpc.branches[":id"].$patch({
      param: { id: b.id },
      json: { status: nextStatus },
    });
    if (!res.ok) {
      toast.error(
        (res.status as number) === 403
          ? "Only admins can manage branches."
          : "Could not update branch status.",
      );
      return;
    }
    toast.success(nextStatus === "active" ? "Branch enabled." : "Branch disabled.");
    load();
  }

  function renderStatus(b: Branch) {
    return (
      <Badge variant={b.status === "active" ? "success" : "secondary"}>
        {b.status === "active" ? "Active" : "Disabled"}
      </Badge>
    );
  }

  function renderActions(b: Branch) {
    return (
      <Row items="center">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${b.name}`}
          onClick={() => openEdit(b)}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${b.status === "active" ? "Disable" : "Enable"} ${b.name}`}
          onClick={() => toggleStatus(b)}
        >
          {b.status === "active" ? "Disable" : "Enable"}
        </Button>
      </Row>
    );
  }

  const columns: DataTableColumn<Branch>[] = [
    { key: "name", header: "Name", sortable: true },
    { key: "code", header: "Code", sortable: true },
    { key: "status", header: "Status", render: renderStatus },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (b) => new Date(b.createdAt).toLocaleString(),
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
        <p className="text-sm text-muted-foreground">
          Venue locations this tenant operates.
        </p>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <Row items="center">
          <DialogTrigger asChild>
            <Button onClick={openCreate}>Add Branch</Button>
          </DialogTrigger>
        </Row>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit branch" : "Add branch"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  placeholder="Generated from name if left blank"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: v as BranchStatus })}
                >
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="contactNumber">Contact number</Label>
                <Input
                  id="contactNumber"
                  value={form.contactNumber}
                  onChange={(e) => setForm({ ...form, contactNumber: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="timezone">Timezone</Label>
                <Input
                  id="timezone"
                  placeholder="Asia/Manila"
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="latitude">Latitude</Label>
                <Input
                  id="latitude"
                  value={form.latitude}
                  onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="longitude">Longitude</Label>
                <Input
                  id="longitude"
                  value={form.longitude}
                  onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="operatingHours">Operating hours</Label>
              <Textarea
                id="operatingHours"
                value={form.operatingHours}
                onChange={(e) => setForm({ ...form, operatingHours: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="googleMapsUrl">Google Maps URL</Label>
              <Input
                id="googleMapsUrl"
                value={form.googleMapsUrl}
                onChange={(e) => setForm({ ...form, googleMapsUrl: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="facebook">Facebook</Label>
                <Input
                  id="facebook"
                  value={form.facebook}
                  onChange={(e) => setForm({ ...form, facebook: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="messenger">Messenger</Label>
                <Input
                  id="messenger"
                  value={form.messenger}
                  onChange={(e) => setForm({ ...form, messenger: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="instagram">Instagram</Label>
                <Input
                  id="instagram"
                  value={form.instagram}
                  onChange={(e) => setForm({ ...form, instagram: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tiktok">TikTok</Label>
                <Input
                  id="tiktok"
                  value={form.tiktok}
                  onChange={(e) => setForm({ ...form, tiktok: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="discord">Discord</Label>
                <Input
                  id="discord"
                  value={form.discord}
                  onChange={(e) => setForm({ ...form, discord: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Create branch"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search branches…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={branches}
          rowKey={(b) => b.id}
          emptyMessage="No branches yet."
          renderCard={(b) => (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{b.name}</p>
                <p className="text-xs text-muted-foreground">{b.code}</p>
              </div>
              <div className="flex items-center gap-2">
                {renderStatus(b)}
                {renderActions(b)}
              </div>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={branches}
          rowKey={(b) => b.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No branches yet."
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
