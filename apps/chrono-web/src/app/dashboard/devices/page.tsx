"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Key, CheckCircle, RefreshCw, Slash } from "lucide-react";
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
  Badge,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

interface Branch {
  id: string;
  name: string;
}

interface Station {
  id: string;
  name: string;
  stationNumber: string;
}

interface DeviceRow {
  id: string;
  branchId: string;
  stationId: string | null;
  deviceFingerprint: string;
  status: string;
  hostname: string | null;
  lastSeenAt: string | null;
}

interface ProvisioningTokenRow {
  id: string;
  branchId: string;
  name: string;
  status: string;
  pairingCodeExpiresAt: string | null;
  maxUses: number | null;
  useCount: number;
}

export default function DevicesPage() {
  const query = useListQuery(["branchId", "status"]);
  const ptQuery = useListQuery(["branchId"]);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [stations, setStations] = useState<Station[]>([]);

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesMeta, setDevicesMeta] = useState<PaginationMeta | null>(null);

  const [tokens, setTokens] = useState<ProvisioningTokenRow[]>([]);

  useEffect(() => {
    let active = true;
    const fetchBranches = async () => {
      const res = await api.rpc.branches.$get({ query: { pageSize: "100" } });
      if (res.ok && active) {
        const { items } = await res.json();
        setBranches(items);
      }
    };
    fetchBranches();
    return () => { active = false; };
  }, []);

  const fetchStations = useCallback(async (branchId?: string) => {
    const res = await api.rpc.stations.$get({
      query: { pageSize: "100", ...(branchId ? { branchId } : {}) }
    });
    if (res.ok) {
      const { items } = await res.json();
      setStations(items);
    }
  }, []);

  useEffect(() => {
    fetchStations();
  }, [fetchStations]);

  const loadDevices = useCallback(async () => {
    const searchParams = new URLSearchParams();
    if (query.q) searchParams.set("q", query.q);
    if (query.sort) searchParams.set("sort", query.sort);
    if (query.order) searchParams.set("order", query.order);
    if (query.page) searchParams.set("page", query.page.toString());
    if (query.pageSize) searchParams.set("pageSize", query.pageSize.toString());
    if (query.filters.branchId) searchParams.set("branchId", query.filters.branchId as string);
    if (query.filters.status) searchParams.set("status", query.filters.status as string);

    const q = Object.fromEntries(searchParams.entries());
    const res = await api.rpc.devices.$get({ query: q });
    if (res.ok) {
      const { items, meta } = await res.json();
      setDevices(items);
      setDevicesMeta(meta);
    }
  }, [
    query.q,
    query.sort,
    query.order,
    query.page,
    query.pageSize,
    query.filters.branchId,
    query.filters.status,
  ]);

  // GET /provisioning-tokens is unpaginated and takes no query params (a
  // genuinely low-cardinality per-branch resource — client-side filter/sort
  // below, per .ai/rules/data-listing.md's useClientListPage exemption).
  const loadTokens = useCallback(async () => {
    const res = await api.rpc.devices["provisioning-tokens"].$get({ query: {} });
    if (res.ok) {
      const { items } = await res.json();
      setTokens(items);
    }
  }, []);

  const filteredTokens = useMemo(() => {
    const branchId = ptQuery.filters.branchId as string | undefined;
    const q = ptQuery.q?.toLowerCase();
    let rows = tokens;
    if (branchId) rows = rows.filter((t) => t.branchId === branchId);
    if (q) rows = rows.filter((t) => t.name?.toLowerCase().includes(q));
    if (ptQuery.sort) {
      const dir = ptQuery.order === "desc" ? -1 : 1;
      const sortKey = ptQuery.sort as keyof ProvisioningTokenRow;
      rows = [...rows].sort((a, b) => {
        const av = a[sortKey] ?? "";
        const bv = b[sortKey] ?? "";
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }
    return rows;
  }, [tokens, ptQuery.filters.branchId, ptQuery.q, ptQuery.sort, ptQuery.order]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  // Token Generation Form
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenForm, setTokenForm] = useState({
    name: "",
    branchId: "",
    pairingCodeTtlMinutes: "60",
    maxUses: "",
  });
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

  const createToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setTokenSaving(true);
    const payload = {
      name: tokenForm.name,
      branchId: tokenForm.branchId,
      pairingCodeTtlMinutes: parseInt(tokenForm.pairingCodeTtlMinutes, 10) || 60,
      ...(tokenForm.maxUses ? { maxUses: parseInt(tokenForm.maxUses, 10) } : {}),
    };
    try {
      const res = await api.rpc.devices["provisioning-tokens"].$post({ json: payload });
      if (res.ok) {
        const data = await res.json();
        setGeneratedCode(data.provisioningToken?.pairingCode ?? null);
        toast.success("Pairing code generated");
        loadTokens();
      } else {
        toast.error("Failed to generate code");
      }
    } catch {
      toast.error("An error occurred");
    } finally {
      setTokenSaving(false);
    }
  };

  const closeTokenDialog = () => {
    setTokenDialogOpen(false);
    setGeneratedCode(null);
    setTokenForm({ name: "", branchId: "", pairingCodeTtlMinutes: "60", maxUses: "" });
  };

  // Device Approve Form
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [deviceToApprove, setDeviceToApprove] = useState<DeviceRow | null>(null);
  const [approveSaving, setApproveSaving] = useState(false);
  const [approveMode, setApproveMode] = useState<"existing" | "new">("existing");
  const [approveForm, setApproveForm] = useState({
    stationId: "",
    newStationName: "",
    newStationNumber: "",
  });

  const openApprove = (device: DeviceRow) => {
    setDeviceToApprove(device);
    setApproveMode("existing");
    setApproveForm({ stationId: "", newStationName: "", newStationNumber: "" });
    setApproveDialogOpen(true);
  };

  const submitApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceToApprove) return;
    setApproveSaving(true);
    const payload =
      approveMode === "existing"
        ? { stationId: approveForm.stationId }
        : {
            newStationName: approveForm.newStationName,
            newStationNumber: approveForm.newStationNumber,
          };

    try {
      const res = await api.rpc.devices[":id"].approve.$post({
        param: { id: deviceToApprove.id },
        json: payload,
      });
      if (res.ok) {
        toast.success("Device approved");
        setApproveDialogOpen(false);
        loadDevices();
      } else {
        toast.error("Failed to approve device");
      }
    } catch {
      toast.error("An error occurred");
    } finally {
      setApproveSaving(false);
    }
  };

  // Device Relink Form
  const [relinkDialogOpen, setRelinkDialogOpen] = useState(false);
  const [deviceToRelink, setDeviceToRelink] = useState<DeviceRow | null>(null);
  const [relinkSaving, setRelinkSaving] = useState(false);
  const [relinkStationId, setRelinkStationId] = useState("");

  const openRelink = (device: DeviceRow) => {
    setDeviceToRelink(device);
    setRelinkStationId(device.stationId || "");
    setRelinkDialogOpen(true);
  };

  const submitRelink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceToRelink) return;
    setRelinkSaving(true);
    try {
      const res = await api.rpc.devices[":id"].link.$patch({
        param: { id: deviceToRelink.id },
        json: { stationId: relinkStationId },
      });
      if (res.ok) {
        toast.success("Device relinked");
        setRelinkDialogOpen(false);
        loadDevices();
      } else {
        toast.error("Failed to relink device");
      }
    } catch {
      toast.error("An error occurred");
    } finally {
      setRelinkSaving(false);
    }
  };

  // Device Revoke Action
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [deviceToRevoke, setDeviceToRevoke] = useState<DeviceRow | null>(null);
  const [revokeSaving, setRevokeSaving] = useState(false);

  const confirmRevoke = (device: DeviceRow) => {
    setDeviceToRevoke(device);
    setRevokeDialogOpen(true);
  };

  const submitRevoke = async () => {
    if (!deviceToRevoke) return;
    setRevokeSaving(true);
    try {
      const res = await api.rpc.devices[":id"].revoke.$post({
        param: { id: deviceToRevoke.id },
      });
      if (res.ok) {
        toast.success("Device revoked");
        setRevokeDialogOpen(false);
        loadDevices();
      } else {
        toast.error("Failed to revoke device");
      }
    } catch {
      toast.error("An error occurred");
    } finally {
      setRevokeSaving(false);
    }
  };

  // Token Revoke Action
  const revokeToken = async (id: string) => {
    if (!confirm("Revoke this provisioning token?")) return;
    try {
      const res = await api.rpc.devices["provisioning-tokens"][":id"].revoke.$post({
        param: { id },
      });
      if (res.ok) {
        toast.success("Token revoked");
        loadTokens();
      } else {
        toast.error("Failed to revoke token");
      }
    } catch {
      toast.error("An error occurred");
    }
  };

  const deviceColumns: DataTableColumn<DeviceRow>[] = [
    {
      key: "hostname",
      header: "Hostname",
      sortable: true,
      render: (r) => (
        <div>
          <p className="font-medium">{r.hostname || "Unknown Host"}</p>
          <p className="text-xs text-muted-foreground font-mono">{r.deviceFingerprint.substring(0, 8)}...</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (r) => {
        if (r.status === "approved") return <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 hover:bg-green-100">Approved</Badge>;
        if (r.status === "revoked") return <Badge variant="destructive">Revoked</Badge>;
        return <Badge variant="outline">Pending</Badge>;
      }
    },
    {
      key: "stationId",
      header: "Station",
      render: (r) => {
        if (!r.stationId) return <span className="text-muted-foreground">-</span>;
        const s = stations.find(s => s.id === r.stationId);
        return s ? `${s.stationNumber}: ${s.name}` : r.stationId;
      }
    },
    {
      key: "lastSeenAt",
      header: "Last Seen",
      sortable: true,
      render: (r) => r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "Never",
    },
    {
      key: "actions",
      header: "",
      render: (r) => renderDeviceActions(r),
    },
  ];

  const renderDeviceActions = (device: DeviceRow) => {
    return (
      <div className="flex justify-end gap-2">
        {device.status === "pending_approval" && (
          <Button variant="outline" size="sm" onClick={() => openApprove(device)}>
            <CheckCircle className="mr-2 h-4 w-4" /> Approve
          </Button>
        )}
        {device.status === "approved" && (
          <Button variant="outline" size="sm" onClick={() => openRelink(device)}>
            <RefreshCw className="mr-2 h-4 w-4" /> Relink
          </Button>
        )}
        {(device.status === "approved" || device.status === "pending_approval") && (
          <Button variant="outline" size="sm" onClick={() => confirmRevoke(device)}>
            <Slash className="mr-2 h-4 w-4" /> Revoke
          </Button>
        )}
      </div>
    );
  };

  const tokenColumns: DataTableColumn<ProvisioningTokenRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "branchId",
      header: "Branch",
      render: (r) => {
        const b = branches.find(b => b.id === r.branchId);
        return b ? b.name : r.branchId;
      }
    },
    {
      key: "status",
      header: "Status",
      render: (r) => {
        if (r.status === "revoked") return <Badge variant="destructive">Revoked</Badge>;
        if (r.pairingCodeExpiresAt && new Date(r.pairingCodeExpiresAt) < new Date()) return <Badge variant="secondary">Expired</Badge>;
        return <Badge variant="outline">Active</Badge>;
      }
    },
    {
      key: "uses",
      header: "Uses",
      render: (r) => `${r.useCount || 0} ${r.maxUses ? `/ ${r.maxUses}` : ''}`,
    },
    {
      key: "actions",
      header: "",
      render: (r) => r.status !== "revoked" ? (
        <Button variant="ghost" size="icon" onClick={() => revokeToken(r.id)}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      ) : null,
    },
  ];

  return (
    <Stack className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <Row className="justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
          <p className="text-sm text-muted-foreground">
            Manage hardware devices and provisioning tokens.
          </p>
        </div>
      </Row>

      <Tabs defaultValue="devices">
        <TabsList>
          <TabsTrigger value="devices">Devices</TabsTrigger>
          <TabsTrigger value="tokens">Provisioning Tokens</TabsTrigger>
        </TabsList>

        <TabsContent value="devices" className="space-y-4 pt-4">
          <div className="flex flex-col sm:flex-row gap-4 justify-between">
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search devices..."
              view={query.view}
              onViewChange={query.setView}
            >
              <Select
                value={(query.filters.branchId as string) || "all"}
                onValueChange={(v) => query.setFilters({ branchId: v === "all" ? "" : v })}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All Branches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Branches</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={(query.filters.status as string) || "all"}
                onValueChange={(v) => query.setFilters({ status: v === "all" ? "" : v })}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Any Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any Status</SelectItem>
                  <SelectItem value="pending_approval">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="revoked">Revoked</SelectItem>
                </SelectContent>
              </Select>
            </DataTableToolbar>
          </div>

          {query.view === "grid" ? (
            <DataTableGrid
              rows={devices}
              rowKey={(r) => r.id}
              emptyMessage="No devices found."
              renderCard={(r) => (
                <div className="flex flex-col space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-medium">{r.hostname || "Unknown Host"}</p>
                      <p className="text-xs text-muted-foreground font-mono">{r.deviceFingerprint?.substring(0, 8)}...</p>
                    </div>
                    {r.status === "approved" ? (
                      <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Approved</Badge>
                    ) : r.status === "revoked" ? (
                      <Badge variant="destructive">Revoked</Badge>
                    ) : (
                      <Badge variant="outline">Pending</Badge>
                    )}
                  </div>
                  <div>
                    {r.stationId ? (
                      <p className="text-sm">Station: {stations.find(s => s.id === r.stationId)?.name || r.stationId}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unassigned</p>
                    )}
                  </div>
                  <div className="pt-2 border-t flex justify-end">
                    {renderDeviceActions(r)}
                  </div>
                </div>
              )}
            />
          ) : (
            <DataTable
              columns={deviceColumns}
              rows={devices}
              rowKey={(r) => r.id}
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
              emptyMessage="No devices found."
            />
          )}

          {devicesMeta && (
            <DataTablePagination
              meta={devicesMeta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          )}
        </TabsContent>

        <TabsContent value="tokens" className="space-y-4 pt-4">
          <div className="flex flex-col sm:flex-row gap-4 justify-between">
            <DataTableToolbar
              q={ptQuery.q}
              onQChange={ptQuery.setQ}
              searchPlaceholder="Search tokens..."
              view={ptQuery.view}
              onViewChange={ptQuery.setView}
            >
              <Select
                value={(ptQuery.filters.branchId as string) || "all"}
                onValueChange={(v) => ptQuery.setFilters({ branchId: v === "all" ? "" : v })}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All Branches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Branches</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DataTableToolbar>

            <Dialog open={tokenDialogOpen} onOpenChange={(open) => { if(!open) closeTokenDialog(); else setTokenDialogOpen(true); }}>
              <DialogTrigger asChild>
                <Button>
                  <Key className="mr-2 h-4 w-4" /> Generate Pairing Code
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Generate Pairing Code</DialogTitle>
                </DialogHeader>
                {!generatedCode ? (
                  <form onSubmit={createToken} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2 col-span-2">
                        <Label htmlFor="t-branch">Branch *</Label>
                        <Select
                          value={tokenForm.branchId}
                          onValueChange={(v) => setTokenForm({ ...tokenForm, branchId: v })}
                          required
                        >
                          <SelectTrigger id="t-branch">
                            <SelectValue placeholder="Select branch" />
                          </SelectTrigger>
                          <SelectContent>
                            {branches.map((b) => (
                              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2 col-span-2">
                        <Label htmlFor="t-name">Name *</Label>
                        <Input
                          id="t-name"
                          value={tokenForm.name}
                          onChange={(e) => setTokenForm({ ...tokenForm, name: e.target.value })}
                          required
                          placeholder="e.g. Reception PC Setup"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="t-ttl">Expires in (minutes)</Label>
                        <Input
                          id="t-ttl"
                          type="number"
                          min="1"
                          value={tokenForm.pairingCodeTtlMinutes}
                          onChange={(e) => setTokenForm({ ...tokenForm, pairingCodeTtlMinutes: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="t-uses">Max Uses (optional)</Label>
                        <Input
                          id="t-uses"
                          type="number"
                          min="1"
                          placeholder="Unbounded"
                          value={tokenForm.maxUses}
                          onChange={(e) => setTokenForm({ ...tokenForm, maxUses: e.target.value })}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={tokenSaving || !tokenForm.branchId || !tokenForm.name}>
                        {tokenSaving ? "Generating..." : "Generate"}
                      </Button>
                    </DialogFooter>
                  </form>
                ) : (
                  <div className="space-y-6 text-center py-4">
                    <p className="text-sm text-muted-foreground">
                      Enter this pairing code on the device to authenticate. This code is only shown once.
                    </p>
                    <div className="text-4xl font-mono tracking-widest font-bold bg-muted p-6 rounded-lg select-all">
                      {generatedCode}
                    </div>
                    <DialogFooter>
                      <Button onClick={closeTokenDialog} className="w-full">Done</Button>
                    </DialogFooter>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>

          <DataTable
            columns={tokenColumns}
            rows={filteredTokens}
            rowKey={(r) => r.id}
            sort={ptQuery.sort}
            order={ptQuery.order}
            onSortChange={ptQuery.setSort}
            emptyMessage="No provisioning tokens found."
          />
        </TabsContent>
      </Tabs>

      {/* Approve Dialog */}
      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Device</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitApprove} className="space-y-4">
            <div className="space-y-4">
              <div className="flex gap-4">
                <Button
                  type="button"
                  variant={approveMode === "existing" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setApproveMode("existing")}
                >
                  Existing Station
                </Button>
                <Button
                  type="button"
                  variant={approveMode === "new" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setApproveMode("new")}
                >
                  New Station
                </Button>
              </div>

              {approveMode === "existing" ? (
                <div className="space-y-2">
                  <Label>Station</Label>
                  <Select
                    value={approveForm.stationId}
                    onValueChange={(v) => setApproveForm({ ...approveForm, stationId: v })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select station" />
                    </SelectTrigger>
                    <SelectContent>
                      {stations.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.stationNumber}: {s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Station Name *</Label>
                    <Input
                      value={approveForm.newStationName}
                      onChange={(e) => setApproveForm({ ...approveForm, newStationName: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Station Number *</Label>
                    <Input
                      value={approveForm.newStationNumber}
                      onChange={(e) => setApproveForm({ ...approveForm, newStationNumber: e.target.value })}
                      required
                    />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={approveSaving || (approveMode === "existing" ? !approveForm.stationId : (!approveForm.newStationName || !approveForm.newStationNumber))}>
                {approveSaving ? "Approving..." : "Approve Device"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Relink Dialog */}
      <Dialog open={relinkDialogOpen} onOpenChange={setRelinkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Relink Device</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitRelink} className="space-y-4">
            <div className="space-y-2">
              <Label>Station</Label>
              <Select
                value={relinkStationId}
                onValueChange={setRelinkStationId}
                required
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select station" />
                </SelectTrigger>
                <SelectContent>
                  {stations.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.stationNumber}: {s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={relinkSaving || !relinkStationId}>
                {relinkSaving ? "Relinking..." : "Relink Device"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Revoke Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke Device</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p>
              Are you sure you want to revoke access for <strong>{deviceToRevoke?.hostname || 'this device'}</strong>?
            </p>
            <p className="text-sm text-muted-foreground">
              This will immediately disconnect the device and invalidate its authentication token. It will need to be re-paired to connect again.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialogOpen(false)} disabled={revokeSaving}>Cancel</Button>
            <Button variant="destructive" onClick={submitRevoke} disabled={revokeSaving}>
              {revokeSaving ? "Revoking..." : "Revoke Device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
