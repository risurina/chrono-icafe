"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  DateTimeInput,
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
  Switch,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type ReservationStatus = "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show";

type Reservation = {
  id: string;
  branchId: string;
  stationId: string;
  memberId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  startAt: string;
  endAt: string;
  status: ReservationStatus;
  notes: string | null;
  createdAt: string;
};

type Branch = { id: string; name: string };
type Station = { id: string; name: string; branchId: string };
type Member = { memberId: string; name: string; email: string };

const FILTER_KEYS = ["branchId", "date"];

const STATUS_VARIANT: Record<ReservationStatus, "default" | "secondary" | "destructive" | "success" | "warning"> = {
  confirmed: "default",
  checked_in: "success",
  completed: "secondary",
  cancelled: "destructive",
  no_show: "warning",
};

const STATUS_LABEL: Record<ReservationStatus, string> = {
  confirmed: "Confirmed",
  checked_in: "Checked in",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

type FormState = {
  branchId: string;
  stationId: string;
  isWalkIn: boolean;
  memberId: string;
  memberQuery: string;
  customerName: string;
  customerPhone: string;
  startAt: string;
  endAt: string;
  notes: string;
};

function emptyForm(branchId: string): FormState {
  return {
    branchId,
    stationId: "",
    isWalkIn: false,
    memberId: "",
    memberQuery: "",
    customerName: "",
    customerPhone: "",
    startAt: "",
    endAt: "",
    notes: "",
  };
}

/** "2026-09-01T14:30" (native datetime-local, no tz) <-> ISO instant. */
function toIso(localValue: string): string | undefined {
  if (!localValue) return undefined;
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function isoToLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function todayLocalDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function ReservationsPage() {
  const query = useListQuery(FILTER_KEYS);
  const branchId = query.filters.branchId ?? "";
  const date = query.filters.date ?? todayLocalDate();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [dialogStations, setDialogStations] = useState<Station[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm(""));
  const [saving, setSaving] = useState(false);
  const [memberResults, setMemberResults] = useState<Member[]>([]);

  // Load branches once; default to the first branch if none selected yet.
  useEffect(() => {
    (async () => {
      const res = await api.rpc.branches.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        const items = body.items as Branch[];
        setBranches(items);
        if (!branchId && items[0]) {
          query.setFilters({ branchId: items[0].id });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stations for the currently selected branch (board filter).
  useEffect(() => {
    if (!branchId) {
      setStations([]);
      return;
    }
    (async () => {
      const res = await api.rpc.stations.$get({ query: { branchId, pageSize: "200" } });
      if (res.ok) {
        const body = await res.json();
        setStations(body.items as Station[]);
      } else {
        setStations([]);
      }
    })();
  }, [branchId]);

  // Stations for the dialog's chosen branch (may differ from the board filter).
  useEffect(() => {
    if (!form.branchId) {
      setDialogStations([]);
      return;
    }
    (async () => {
      const res = await api.rpc.stations.$get({
        query: { branchId: form.branchId, pageSize: "200" },
      });
      if (res.ok) {
        const body = await res.json();
        setDialogStations(body.items as Station[]);
      } else {
        setDialogStations([]);
      }
    })();
  }, [form.branchId]);

  const load = useCallback(async () => {
    if (!branchId) {
      setReservations([]);
      setMeta(null);
      return;
    }
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59.999`);
    const res = await api.rpc.reservations.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort ?? "startAt",
        order: query.order,
        branchId,
        from: dayStart.toISOString(),
        to: dayEnd.toISOString(),
      },
    });
    if (res.ok) {
      const body = await res.json();
      setReservations(body.items as Reservation[]);
      setMeta(body.meta as PaginationMeta);
    } else {
      setReservations([]);
      setMeta(null);
    }
  }, [branchId, date, query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  // Member search for the walk-in toggle.
  useEffect(() => {
    if (form.isWalkIn || !form.memberQuery.trim()) {
      setMemberResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      const res = await api.rpc["member-profiles"].$get({
        query: { q: form.memberQuery, pageSize: "10" },
      });
      if (res.ok) {
        const body = await res.json();
        setMemberResults(body.items as Member[]);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [form.memberQuery, form.isWalkIn]);

  function stationName(stationId: string): string {
    return stations.find((s) => s.id === stationId)?.name ?? stationId;
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyForm(branchId));
    setDialogOpen(true);
  }

  function openEdit(r: Reservation) {
    setEditing(r);
    setForm({
      branchId: r.branchId,
      stationId: r.stationId,
      isWalkIn: !r.memberId,
      memberId: r.memberId ?? "",
      memberQuery: "",
      customerName: r.customerName ?? "",
      customerPhone: r.customerPhone ?? "",
      startAt: isoToLocal(r.startAt),
      endAt: isoToLocal(r.endAt),
      notes: r.notes ?? "",
    });
    setDialogOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const startIso = toIso(form.startAt);
    const endIso = toIso(form.endAt);
    if (!form.stationId || !startIso || !endIso) return;

    setSaving(true);
    const res = editing
      ? await api.rpc.reservations[":id"].$patch({
          param: { id: editing.id },
          json: {
            stationId: form.stationId,
            startAt: startIso,
            endAt: endIso,
            notes: form.notes.trim() || undefined,
          },
        })
      : await api.rpc.reservations.$post({
          json: {
            branchId: form.branchId,
            stationId: form.stationId,
            memberId: form.isWalkIn ? undefined : form.memberId || undefined,
            customerName: form.isWalkIn ? form.customerName.trim() || undefined : undefined,
            customerPhone: form.isWalkIn ? form.customerPhone.trim() || undefined : undefined,
            startAt: startIso,
            endAt: endIso,
            notes: form.notes.trim() || undefined,
          },
        });
    setSaving(false);

    if (!res.ok) {
      let message = editing ? "Could not update reservation." : "Could not create reservation.";
      if ((res.status as number) === 403) {
        message = "You don't have permission to manage reservations.";
      } else {
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          message = body.error ?? body.message ?? message;
        } catch {
          // keep default message
        }
      }
      toast.error(message);
      return;
    }
    toast.success(editing ? "Reservation updated." : "Reservation created.");
    setDialogOpen(false);
    load();
  }

  async function checkIn(r: Reservation) {
    const res = await api.rpc.reservations[":id"]["check-in"].$post({ param: { id: r.id } });
    if (!res.ok) {
      toast.error("Could not check in this reservation.");
      return;
    }
    toast.success("Checked in.");
    load();
  }

  async function cancel(r: Reservation) {
    const res = await api.rpc.reservations[":id"].cancel.$post({
      param: { id: r.id },
      json: {},
    });
    if (!res.ok) {
      toast.error("Could not cancel this reservation.");
      return;
    }
    toast.success("Reservation cancelled.");
    load();
  }

  async function noShow(r: Reservation) {
    const res = await api.rpc.reservations[":id"]["no-show"].$post({ param: { id: r.id } });
    if (!res.ok) {
      toast.error("Could not mark this reservation as a no-show.");
      return;
    }
    toast.success("Marked as no-show.");
    load();
  }

  function renderStatus(r: Reservation) {
    return <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>;
  }

  function renderActions(r: Reservation) {
    if (r.status !== "confirmed") {
      return renderStatus(r);
    }
    return (
      <Row items="center">
        <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => checkIn(r)}>
          Check In
        </Button>
        <Button variant="ghost" size="sm" onClick={() => cancel(r)}>
          Cancel
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => noShow(r)}
        >
          No Show
        </Button>
      </Row>
    );
  }

  const columns: DataTableColumn<Reservation>[] = [
    {
      key: "startAt",
      header: "Time",
      sortable: true,
      render: (r) =>
        `${new Date(r.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(
          r.endAt,
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    },
    { key: "station", header: "Station", render: (r) => stationName(r.stationId) },
    {
      key: "customer",
      header: "Customer",
      render: (r) => r.customerName ?? r.memberId ?? "—",
    },
    { key: "status", header: "Status", render: renderStatus },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reservations</h1>
        <p className="text-sm text-muted-foreground">
          Book and manage station reservations for a branch and day.
        </p>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <Row items="center">
          <div className="w-56">
            <Select
              value={branchId}
              onValueChange={(v) => query.setFilters({ branchId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            type="date"
            className="w-44"
            value={date}
            onChange={(e) => query.setFilters({ date: e.target.value })}
          />
          <DialogTrigger asChild>
            <Button onClick={openCreate} disabled={!branchId}>
              Add Reservation
            </Button>
          </DialogTrigger>
        </Row>

        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit reservation" : "Add reservation"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="res-branch">Branch</Label>
                <Select
                  value={form.branchId}
                  onValueChange={(v) =>
                    setForm({ ...form, branchId: v, stationId: "" })
                  }
                  disabled={!!editing}
                >
                  <SelectTrigger id="res-branch">
                    <SelectValue placeholder="Select a branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="res-station">Station</Label>
                <Select
                  value={form.stationId}
                  onValueChange={(v) => setForm({ ...form, stationId: v })}
                  disabled={!form.branchId}
                >
                  <SelectTrigger id="res-station">
                    <SelectValue placeholder="Select a station" />
                  </SelectTrigger>
                  <SelectContent>
                    {dialogStations.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!editing ? (
              <div className="space-y-2">
                <Row items="center">
                  <Switch
                    checked={form.isWalkIn}
                    onCheckedChange={(checked) =>
                      setForm({ ...form, isWalkIn: checked, memberId: "" })
                    }
                  />
                  <Label>Walk-in (no member account)</Label>
                </Row>

                {form.isWalkIn ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="res-customer-name">Customer name</Label>
                      <Input
                        id="res-customer-name"
                        value={form.customerName}
                        onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="res-customer-phone">Phone</Label>
                      <Input
                        id="res-customer-phone"
                        value={form.customerPhone}
                        onChange={(e) => setForm({ ...form, customerPhone: e.target.value })}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="res-member">Member</Label>
                    <Input
                      id="res-member"
                      placeholder="Search members by name or email…"
                      value={form.memberQuery}
                      onChange={(e) =>
                        setForm({ ...form, memberQuery: e.target.value, memberId: "" })
                      }
                    />
                    {memberResults.length > 0 && !form.memberId ? (
                      <div className="rounded-md border divide-y">
                        {memberResults.map((m) => (
                          <Button
                            key={m.memberId}
                            type="button"
                            variant="ghost"
                            className="w-full justify-start rounded-none"
                            onClick={() =>
                              setForm({
                                ...form,
                                memberId: m.memberId,
                                memberQuery: `${m.name} (${m.email})`,
                              })
                            }
                          >
                            {m.name} — {m.email}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="res-start">Start</Label>
                <DateTimeInput
                  id="res-start"
                  value={form.startAt}
                  onChange={(e) => setForm({ ...form, startAt: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="res-end">End</Label>
                <DateTimeInput
                  id="res-end"
                  value={form.endAt}
                  onChange={(e) => setForm({ ...form, endAt: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="res-notes">Notes</Label>
              <Textarea
                id="res-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>

            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Create reservation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search reservations…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={reservations}
          rowKey={(r) => r.id}
          emptyMessage="No reservations for this branch and day."
          renderCard={(r) => (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{stationName(r.stationId)}</p>
                <p className="text-xs text-muted-foreground">
                  {r.customerName ?? r.memberId ?? "—"}
                </p>
              </div>
              <div className="flex items-center gap-2">{renderActions(r)}</div>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={reservations}
          rowKey={(r) => r.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No reservations for this branch and day."
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
