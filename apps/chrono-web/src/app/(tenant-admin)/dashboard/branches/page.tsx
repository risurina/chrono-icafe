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
import type { HoursConfigInput } from "@agora/chrono-api/branch";

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
  hoursConfig: HoursConfigInput | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Structured hours editor state. `HoursConfigInput` (the day-of-week union
// contract from `@agora/chrono-api/branch`, `hoursConfigSchema`) is the
// on-the-wire shape; `HoursFormState` is a friendlier local shape for the
// day-row editor below (an explicit `mode` instead of a discriminated-by-value
// union) that converts to/from it at the form boundary.
// ---------------------------------------------------------------------------

type DayKey = keyof HoursConfigInput;
type DayMode = "closed" | "open" | "24h";
type DayFormState = { mode: DayMode; open: string; close: string };
type HoursFormState = Record<DayKey, DayFormState>;

const DAY_DEFS: { key: DayKey; label: string }[] = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
];

const DEFAULT_DAY_FORM: DayFormState = { mode: "closed", open: "09:00", close: "17:00" };

function emptyHoursForm(): HoursFormState {
  const form = {} as HoursFormState;
  for (const d of DAY_DEFS) form[d.key] = { ...DEFAULT_DAY_FORM };
  return form;
}

/** A missing/absent day (or an explicit `"closed"`) both render as Closed. */
function hoursConfigToForm(hc: HoursConfigInput | null | undefined): HoursFormState {
  const form = emptyHoursForm();
  if (!hc) return form;
  for (const d of DAY_DEFS) {
    const entry = hc[d.key];
    if (!entry || entry === "closed") {
      form[d.key] = { ...DEFAULT_DAY_FORM };
    } else if (entry === "24h") {
      form[d.key] = { mode: "24h", open: DEFAULT_DAY_FORM.open, close: DEFAULT_DAY_FORM.close };
    } else {
      form[d.key] = { mode: "open", open: entry.open, close: entry.close };
    }
  }
  return form;
}

/** Always writes an explicit value per day — never leaves a day absent. */
function formToHoursConfig(hf: HoursFormState): HoursConfigInput {
  const out = {} as HoursConfigInput;
  for (const d of DAY_DEFS) {
    const s = hf[d.key];
    out[d.key] =
      s.mode === "closed" ? "closed" : s.mode === "24h" ? "24h" : { open: s.open, close: s.close };
  }
  return out;
}

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
  hours: HoursFormState;
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
  hours: emptyHoursForm(),
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
    hours: hoursConfigToForm(b.hoursConfig),
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
    hoursConfig: formToHoursConfig(f.hours),
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

  function setDayMode(day: DayKey, mode: DayMode) {
    setForm((f) => ({
      ...f,
      hours: { ...f.hours, [day]: { ...f.hours[day], mode } },
    }));
  }

  function setDayTime(day: DayKey, field: "open" | "close", value: string) {
    setForm((f) => ({
      ...f,
      hours: { ...f.hours, [day]: { ...f.hours[day], [field]: value } },
    }));
  }

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
          Business locations this tenant operates.
        </p>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <Row items="center">
          <DialogTrigger asChild>
            <Button onClick={openCreate}>Add Branch</Button>
          </DialogTrigger>
        </Row>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
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
              <Label>Structured hours</Label>
              <p className="text-xs text-muted-foreground">
                Drives the live &ldquo;Open now&rdquo; / &ldquo;Opens at&rdquo; status shown
                on the public site, alongside the free-text note above.
              </p>
              <Stack gap={2}>
                {DAY_DEFS.map((day) => {
                  const state = form.hours[day.key];
                  return (
                    <Row key={day.key} items="center" gap={3} wrap>
                      <span className="w-24 shrink-0 text-sm font-medium">{day.label}</span>
                      <Select
                        value={state.mode}
                        onValueChange={(v) => setDayMode(day.key, v as DayMode)}
                      >
                        <SelectTrigger
                          id={`hours-${day.key}-mode`}
                          aria-label={`${day.label} hours`}
                          className="w-32 shrink-0"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="closed">Closed</SelectItem>
                          <SelectItem value="open">Open</SelectItem>
                          <SelectItem value="24h">24 hours</SelectItem>
                        </SelectContent>
                      </Select>
                      {state.mode === "open" ? (
                        <Row items="center" gap={2}>
                          <Input
                            type="time"
                            aria-label={`${day.label} opening time`}
                            value={state.open}
                            onChange={(e) => setDayTime(day.key, "open", e.target.value)}
                            required
                            className="w-28"
                          />
                          <span className="text-xs text-muted-foreground">to</span>
                          <Input
                            type="time"
                            aria-label={`${day.label} closing time`}
                            value={state.close}
                            onChange={(e) => setDayTime(day.key, "close", e.target.value)}
                            required
                            className="w-28"
                          />
                        </Row>
                      ) : null}
                    </Row>
                  );
                })}
              </Stack>
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
