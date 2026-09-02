"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, X, QrCode } from "lucide-react";
import QRCode from "qrcode";
import {
  Button,
  Input,
  Label,
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";
import { connectChronoRealtime, onStationStatus } from "@/lib/realtime";
import type { StationStatusEvent } from "@agora/chrono-api/realtime";

type StationQrStatus = {
  stationId: string;
  qrSecretVersion: number;
  token: string;
  qrUrl: string;
  expiresAt: string;
};

type StationStatus = "available" | "occupied" | "maintenance" | "offline";

type StationGroup = {
  id: string;
  branchId: string;
  name: string;
  code: string;
  description: string | null;
  hourlyRate: string;
  memberRate: string | null;
  createdAt: string;
  updatedAt: string;
};

type Station = {
  id: string;
  branchId: string;
  stationGroupId: string | null;
  name: string;
  stationNumber: string;
  stationType: string;
  status: StationStatus;
  locationZone: string | null;
  specs: {
    cpu?: string | null;
    gpu?: string | null;
    ram?: string | null;
    monitorHz?: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type Branch = {
  id: string;
  name: string;
  code: string;
};

type StationFormState = {
  branchId: string;
  stationGroupId: string; // "none" | id
  name: string;
  stationNumber: string;
  stationType: string;
  status: StationStatus;
  locationZone: string;
  cpu: string;
  gpu: string;
  ram: string;
  monitorHz: string;
};

const EMPTY_STATION_FORM: StationFormState = {
  branchId: "",
  stationGroupId: "none",
  name: "",
  stationNumber: "",
  stationType: "pc",
  status: "available",
  locationZone: "",
  cpu: "",
  gpu: "",
  ram: "",
  monitorHz: "",
};

type GroupFormState = {
  branchId: string;
  name: string;
  code: string;
  description: string;
  hourlyRate: string;
  memberRate: string;
};

const EMPTY_GROUP_FORM: GroupFormState = {
  branchId: "",
  name: "",
  code: "",
  description: "",
  hourlyRate: "0",
  memberRate: "",
};

export default function StationsPage() {
  const [activeTab, setActiveTab] = useState("stations");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [groups, setGroups] = useState<StationGroup[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  
  const [stationsMeta, setStationsMeta] = useState<PaginationMeta | null>(null);
  const [groupsMeta, setGroupsMeta] = useState<PaginationMeta | null>(null);

  const query = useListQuery(["branchId"]);
  const branchId = query.filters.branchId as string | undefined;

  const loadBranches = useCallback(async () => {
    // simplified load just for selection
    const res = await api.rpc.branches.$get({ query: { pageSize: "100" } });
    if (res.ok) {
      const body = await res.json();
      setBranches(body.items as Branch[]);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    const res = await (api.rpc as any).stations.groups.$get({
      query: {
        page: activeTab === "groups" ? String(query.page) : "1",
        pageSize: activeTab === "groups" ? String(query.pageSize) : "100", // Need all for the dropdown
        branchId: branchId,
        q: activeTab === "groups" ? query.q || undefined : undefined,
        sort: activeTab === "groups" ? query.sort : undefined,
        order: activeTab === "groups" ? query.order : undefined,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setGroups(body.items as StationGroup[]);
      if (activeTab === "groups") {
        setGroupsMeta(body.meta as PaginationMeta);
      }
    }
  }, [
    activeTab,
    query.page,
    query.pageSize,
    query.q,
    query.sort,
    query.order,
    branchId,
  ]);

  const loadStations = useCallback(async () => {
    if (activeTab !== "stations") return;
    const res = await (api.rpc as any).stations.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        branchId: branchId,
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setStations(body.items as Station[]);
      setStationsMeta(body.meta as PaginationMeta);
    }
  }, [activeTab, query.page, query.pageSize, query.q, query.sort, query.order, branchId]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    loadStations();
  }, [loadStations]);

  // Live station-status updates for the currently-filtered branch (Phase 2a,
  // .ai/plans/chrono/active/realtime-updates/README.md). Purely additive —
  // this page has no existing poll/interval to preserve (it fetches on mount
  // and on filter change only), so the socket is the only live-update path
  // here; a page reload or filter change still gets the authoritative list
  // from `loadStations()` above.
  useEffect(() => {
    if (activeTab !== "stations" || !branchId) return;
    const connection = connectChronoRealtime([`branch:${branchId}`]);
    const offStatus = onStationStatus(connection, (event: StationStatusEvent) => {
      setStations((prev) =>
        prev.map((s) => (s.id === event.stationId ? { ...s, status: event.status } : s)),
      );
    });
    return () => {
      offStatus();
      connection.close();
    };
  }, [activeTab, branchId]);


  // Station Dialog State
  const [stationDialogOpen, setStationDialogOpen] = useState(false);
  const [editingStation, setEditingStation] = useState<Station | null>(null);
  const [stationForm, setStationForm] = useState<StationFormState>(EMPTY_STATION_FORM);
  const [stationSaving, setStationSaving] = useState(false);
  const [confirmingStationId, setConfirmingStationId] = useState<string | null>(null);

  // Group Dialog State
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<StationGroup | null>(null);
  const [groupForm, setGroupForm] = useState<GroupFormState>(EMPTY_GROUP_FORM);
  const [groupSaving, setGroupSaving] = useState(false);
  const [confirmingGroupId, setConfirmingGroupId] = useState<string | null>(null);

  // QR Dialog State
  const [qrDialogStation, setQrDialogStation] = useState<Station | null>(null);
  const [qrStatus, setQrStatus] = useState<StationQrStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  async function openQrDialog(s: Station) {
    setQrDialogStation(s);
    setQrStatus(null);
    setQrImage(null);
    await regenerateQr(s.id);
  }

  async function regenerateQr(stationId: string) {
    setQrLoading(true);
    const res = await ((api.rpc as any).stations[":id"].qr.regenerate.$post as any)({
      param: { id: stationId },
    });
    setQrLoading(false);
    if (!res.ok) {
      toast.error(
        (res.status as number) === 403
          ? "You don't have permission to manage this station's QR code."
          : "Could not regenerate QR code.",
      );
      return;
    }
    const status = (await res.json()) as StationQrStatus;
    setQrStatus(status);
    const fullUrl = `${window.location.protocol}//${window.location.host}${status.qrUrl}`;
    const dataUrl = await QRCode.toDataURL(fullUrl, { width: 256, margin: 1 });
    setQrImage(dataUrl);
  }

  // Station Actions
  function openCreateStation() {
    setEditingStation(null);
    setStationForm({ ...EMPTY_STATION_FORM, branchId: branchId || (branches[0]?.id ?? "") });
    setStationDialogOpen(true);
  }

  function openEditStation(s: Station) {
    setEditingStation(s);
    setStationForm({
      branchId: s.branchId,
      stationGroupId: s.stationGroupId || "none",
      name: s.name,
      stationNumber: s.stationNumber,
      stationType: s.stationType,
      status: s.status,
      locationZone: s.locationZone || "",
      cpu: s.specs?.cpu || "",
      gpu: s.specs?.gpu || "",
      ram: s.specs?.ram || "",
      monitorHz: s.specs?.monitorHz ? String(s.specs.monitorHz) : "",
    });
    setStationDialogOpen(true);
  }

  async function saveStation(e: React.FormEvent) {
    e.preventDefault();
    if (!stationForm.name.trim() || !stationForm.stationNumber.trim() || !stationForm.branchId) return;
    setStationSaving(true);
    const specs = {
      cpu: stationForm.cpu.trim() || undefined,
      gpu: stationForm.gpu.trim() || undefined,
      ram: stationForm.ram.trim() || undefined,
      monitorHz: stationForm.monitorHz ? parseInt(stationForm.monitorHz, 10) : undefined,
    };
    const hasSpecs = Object.values(specs).some((v) => v !== undefined);
    
    const payload = {
      branchId: editingStation ? undefined : stationForm.branchId,
      stationGroupId: stationForm.stationGroupId === "none" ? undefined : stationForm.stationGroupId,
      name: stationForm.name.trim(),
      stationNumber: stationForm.stationNumber.trim(),
      stationType: stationForm.stationType.trim() || undefined,
      status: stationForm.status,
      locationZone: stationForm.locationZone.trim() || undefined,
      specs: hasSpecs ? specs : undefined,
    };

    // Ignore type error for client rpc not having exact infer (due to offline generation). 
    // Types from contracts are: `branchId` missing on update, but the schema has omit({ branchId: true })
    const res = editingStation
      ? await ((api.rpc as any).stations[":id"].$patch as any)({
          param: { id: editingStation.id },
          json: payload,
        })
      : await ((api.rpc as any).stations.$post as any)({ json: payload });

    setStationSaving(false);
    if (!res.ok) {
      toast.error(
        (res.status as number) === 409
          ? "A station with that number already exists in this branch."
          : (res.status as number) === 403
            ? "You don't have permission to manage stations."
            : editingStation
              ? "Could not update station."
              : "Could not create station.",
      );
      return;
    }
    toast.success(editingStation ? "Station updated." : "Station created.");
    setStationDialogOpen(false);
    loadStations();
  }

  async function removeStation(id: string) {
    setConfirmingStationId(null);
    const res = await ((api.rpc as any).stations[":id"].$delete as any)({ param: { id } });
    if (res.ok) loadStations();
    else if ((res.status as number) === 403)
      toast.error("You don't have permission to delete stations.");
    else toast.error("Could not delete station.");
  }

  // Group Actions
  function openCreateGroup() {
    setEditingGroup(null);
    setGroupForm({ ...EMPTY_GROUP_FORM, branchId: branchId || (branches[0]?.id ?? "") });
    setGroupDialogOpen(true);
  }

  function openEditGroup(g: StationGroup) {
    setEditingGroup(g);
    setGroupForm({
      branchId: g.branchId,
      name: g.name,
      code: g.code,
      description: g.description || "",
      hourlyRate: g.hourlyRate,
      memberRate: g.memberRate || "",
    });
    setGroupDialogOpen(true);
  }

  async function saveGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!groupForm.name.trim() || !groupForm.code.trim() || !groupForm.branchId) return;
    setGroupSaving(true);
    const payload = {
      branchId: editingGroup ? undefined : groupForm.branchId,
      name: groupForm.name.trim(),
      code: groupForm.code.trim(),
      description: groupForm.description.trim() || undefined,
      hourlyRate: parseFloat(groupForm.hourlyRate),
      memberRate: groupForm.memberRate ? parseFloat(groupForm.memberRate) : undefined,
    };

    const res = editingGroup
      ? await ((api.rpc as any).stations.groups[":id"].$patch as any)({
          param: { id: editingGroup.id },
          json: payload,
        })
      : await ((api.rpc as any).stations.groups.$post as any)({ json: payload });

    setGroupSaving(false);
    if (!res.ok) {
      toast.error(
        (res.status as number) === 409
          ? "A station group with that code already exists in this branch."
          : (res.status as number) === 403
            ? "You don't have permission to manage station groups."
            : editingGroup
              ? "Could not update group."
              : "Could not create group.",
      );
      return;
    }
    toast.success(editingGroup ? "Group updated." : "Group created.");
    setGroupDialogOpen(false);
    loadGroups();
  }

  async function removeGroup(id: string) {
    setConfirmingGroupId(null);
    const res = await ((api.rpc as any).stations.groups[":id"].$delete as any)({ param: { id } });
    if (res.ok) loadGroups();
    else if ((res.status as number) === 403)
      toast.error("You don't have permission to delete station groups.");
    else if ((res.status as number) === 409)
      toast.error("Cannot delete group: stations are still assigned to it.");
    else toast.error("Could not delete group.");
  }


  // Renders
  function renderStationActions(s: Station) {
    return confirmingStationId === s.id ? (
      <Row items="center">
        <span className="text-xs text-muted-foreground">Delete?</span>
        <Button variant="destructive" size="sm" onClick={() => removeStation(s.id)}>
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel delete"
          onClick={() => setConfirmingStationId(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </Row>
    ) : (
      <Row items="center">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Show QR for ${s.name}`}
          onClick={() => openQrDialog(s)}
        >
          <QrCode className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${s.name}`}
          onClick={() => openEditStation(s)}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${s.name}`}
          onClick={() => setConfirmingStationId(s.id)}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </Row>
    );
  }

  function renderGroupActions(g: StationGroup) {
    return confirmingGroupId === g.id ? (
      <Row items="center">
        <span className="text-xs text-muted-foreground">Delete?</span>
        <Button variant="destructive" size="sm" onClick={() => removeGroup(g.id)}>
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel delete"
          onClick={() => setConfirmingGroupId(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </Row>
    ) : (
      <Row items="center">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${g.name}`}
          onClick={() => openEditGroup(g)}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${g.name}`}
          onClick={() => setConfirmingGroupId(g.id)}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </Row>
    );
  }

  const stationColumns: DataTableColumn<Station>[] = [
    { key: "stationNumber", header: "Number", sortable: true },
    { key: "name", header: "Name", sortable: true },
    { 
      key: "status", 
      header: "Status", 
      render: (s) => <span className="capitalize">{s.status}</span> 
    },
    {
      key: "stationGroupId",
      header: "Group",
      render: (s) => {
        const g = groups.find(x => x.id === s.stationGroupId);
        return g ? g.name : <span className="text-muted-foreground text-xs">None</span>;
      }
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (s) => new Date(s.createdAt).toLocaleString(),
    },
    { key: "actions", header: "", render: renderStationActions },
  ];

  const groupColumns: DataTableColumn<StationGroup>[] = [
    { key: "code", header: "Code", sortable: true },
    { key: "name", header: "Name", sortable: true },
    { key: "hourlyRate", header: "Hourly Rate", render: (g) => `$${g.hourlyRate}` },
    { key: "memberRate", header: "Member Rate", render: (g) => g.memberRate ? `$${g.memberRate}` : "-" },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (g) => new Date(g.createdAt).toLocaleString(),
    },
    { key: "actions", header: "", render: renderGroupActions },
  ];

  return (
    <Stack>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stations</h1>
          <p className="text-sm text-muted-foreground">
            Manage physical stations, PCs, consoles, and pricing groups.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <Label htmlFor="branch-filter" className="sr-only">Filter by branch</Label>
        <Select 
          value={branchId || "all"} 
          onValueChange={(v) => query.setFilters({ branchId: v === "all" ? "" : v })}
        >
          <SelectTrigger id="branch-filter" className="w-[200px]">
            <SelectValue placeholder="All branches" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All branches</SelectItem>
            {branches.map(b => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="stations">Stations</TabsTrigger>
          <TabsTrigger value="groups">Groups & Rates</TabsTrigger>
        </TabsList>

        <TabsContent value="stations" className="space-y-4 pt-4">
          <div className="flex justify-between items-center">
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search stations…"
              view={query.view}
              onViewChange={query.setView}
            />
            <Dialog open={stationDialogOpen} onOpenChange={setStationDialogOpen}>
              <DialogTrigger asChild>
                <Button onClick={openCreateStation} disabled={branches.length === 0}>
                  Add Station
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{editingStation ? "Edit station" : "Add station"}</DialogTitle>
                </DialogHeader>
                <form onSubmit={saveStation} className="space-y-4">
                  {!editingStation && (
                    <div className="space-y-2">
                      <Label htmlFor="s-branchId">Branch</Label>
                      <Select
                        value={stationForm.branchId}
                        onValueChange={(v) => setStationForm({ ...stationForm, branchId: v, stationGroupId: "none" })}
                      >
                        <SelectTrigger id="s-branchId">
                          <SelectValue placeholder="Select branch" />
                        </SelectTrigger>
                        <SelectContent>
                          {branches.map(b => (
                            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="s-number">Number *</Label>
                      <Input
                        id="s-number"
                        value={stationForm.stationNumber}
                        onChange={(e) => setStationForm({ ...stationForm, stationNumber: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="s-name">Name *</Label>
                      <Input
                        id="s-name"
                        value={stationForm.name}
                        onChange={(e) => setStationForm({ ...stationForm, name: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="s-group">Group</Label>
                      <Select
                        value={stationForm.stationGroupId}
                        onValueChange={(v) => setStationForm({ ...stationForm, stationGroupId: v })}
                      >
                        <SelectTrigger id="s-group">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {groups.filter(g => !stationForm.branchId || g.branchId === stationForm.branchId).map(g => (
                            <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="s-status">Status</Label>
                      <Select
                        value={stationForm.status}
                        onValueChange={(v) => setStationForm({ ...stationForm, status: v as StationStatus })}
                      >
                        <SelectTrigger id="s-status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="available">Available</SelectItem>
                          <SelectItem value="maintenance">Maintenance</SelectItem>
                          <SelectItem value="offline">Offline</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="s-type">Type</Label>
                      <Input
                        id="s-type"
                        value={stationForm.stationType}
                        onChange={(e) => setStationForm({ ...stationForm, stationType: e.target.value })}
                        placeholder="e.g. pc, console"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="s-zone">Location Zone</Label>
                      <Input
                        id="s-zone"
                        value={stationForm.locationZone}
                        onChange={(e) => setStationForm({ ...stationForm, locationZone: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="pt-4 border-t">
                    <h3 className="font-medium text-sm mb-3">Specifications (Optional)</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="s-cpu">CPU</Label>
                        <Input
                          id="s-cpu"
                          value={stationForm.cpu}
                          onChange={(e) => setStationForm({ ...stationForm, cpu: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="s-gpu">GPU</Label>
                        <Input
                          id="s-gpu"
                          value={stationForm.gpu}
                          onChange={(e) => setStationForm({ ...stationForm, gpu: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="s-ram">RAM</Label>
                        <Input
                          id="s-ram"
                          value={stationForm.ram}
                          onChange={(e) => setStationForm({ ...stationForm, ram: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="s-hz">Monitor Hz</Label>
                        <Input
                          id="s-hz"
                          type="number"
                          value={stationForm.monitorHz}
                          onChange={(e) => setStationForm({ ...stationForm, monitorHz: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={stationSaving}>
                      {stationSaving ? "Saving…" : editingStation ? "Save changes" : "Create station"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {query.view === "grid" ? (
            <DataTableGrid
              rows={stations}
              rowKey={(s) => s.id}
              emptyMessage="No stations yet."
              renderCard={(s) => (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{s.stationNumber}: {s.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.status} • {groups.find(g => g.id === s.stationGroupId)?.name || "No group"}
                    </p>
                  </div>
                  {renderStationActions(s)}
                </div>
              )}
            />
          ) : (
            <DataTable
              columns={stationColumns}
              rows={stations}
              rowKey={(s) => s.id}
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
              emptyMessage="No stations yet."
            />
          )}

          {stationsMeta ? (
            <DataTablePagination
              meta={stationsMeta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="groups" className="space-y-4 pt-4">
          <div className="flex justify-between items-center">
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search groups…"
              view={query.view}
              onViewChange={query.setView}
            />
            <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
              <DialogTrigger asChild>
                <Button onClick={openCreateGroup} disabled={branches.length === 0}>
                  Add Group
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>{editingGroup ? "Edit group" : "Add group"}</DialogTitle>
                </DialogHeader>
                <form onSubmit={saveGroup} className="space-y-4">
                  {!editingGroup && (
                    <div className="space-y-2">
                      <Label htmlFor="g-branchId">Branch</Label>
                      <Select
                        value={groupForm.branchId}
                        onValueChange={(v) => setGroupForm({ ...groupForm, branchId: v })}
                      >
                        <SelectTrigger id="g-branchId">
                          <SelectValue placeholder="Select branch" />
                        </SelectTrigger>
                        <SelectContent>
                          {branches.map(b => (
                            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="g-name">Name *</Label>
                      <Input
                        id="g-name"
                        value={groupForm.name}
                        onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="g-code">Code *</Label>
                      <Input
                        id="g-code"
                        value={groupForm.code}
                        onChange={(e) => setGroupForm({ ...groupForm, code: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="g-desc">Description</Label>
                    <Input
                      id="g-desc"
                      value={groupForm.description}
                      onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="g-hrate">Hourly Rate ($) *</Label>
                      <Input
                        id="g-hrate"
                        type="number"
                        step="0.01"
                        min="0"
                        value={groupForm.hourlyRate}
                        onChange={(e) => setGroupForm({ ...groupForm, hourlyRate: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="g-mrate">Member Rate ($)</Label>
                      <Input
                        id="g-mrate"
                        type="number"
                        step="0.01"
                        min="0"
                        value={groupForm.memberRate}
                        onChange={(e) => setGroupForm({ ...groupForm, memberRate: e.target.value })}
                      />
                    </div>
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={groupSaving}>
                      {groupSaving ? "Saving…" : editingGroup ? "Save changes" : "Create group"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {query.view === "grid" ? (
            <DataTableGrid
              rows={groups}
              rowKey={(g) => g.id}
              emptyMessage="No groups yet."
              renderCard={(g) => (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{g.name}</p>
                    <p className="text-xs text-muted-foreground">{g.code}</p>
                  </div>
                  {renderGroupActions(g)}
                </div>
              )}
            />
          ) : (
            <DataTable
              columns={groupColumns}
              rows={groups}
              rowKey={(g) => g.id}
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
              emptyMessage="No groups yet."
            />
          )}

          {groupsMeta ? (
            <DataTablePagination
              meta={groupsMeta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      <Dialog
        open={qrDialogStation !== null}
        onOpenChange={(open) => {
          if (!open) {
            setQrDialogStation(null);
            setQrStatus(null);
            setQrImage(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{qrDialogStation ? `${qrDialogStation.name} — QR code` : "QR code"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            {qrLoading ? (
              <p className="text-sm text-muted-foreground">Generating…</p>
            ) : qrImage && qrStatus ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, not an optimizable remote image */}
                <img src={qrImage} alt="Station QR code" className="h-64 w-64" />
                <p className="text-xs text-muted-foreground">
                  Expires {new Date(qrStatus.expiresAt).toLocaleTimeString()} — regenerate to
                  print a fresh sticker.
                </p>
              </>
            ) : (
              <p className="text-sm text-destructive">Could not load QR code.</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={qrLoading || !qrDialogStation}
              onClick={() => qrDialogStation && regenerateQr(qrDialogStation.id)}
            >
              {qrLoading ? "Regenerating…" : "Regenerate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
