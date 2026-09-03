"use client";

import { useEffect, useState, useCallback } from "react";
import {
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  type DataTableColumn,
  Button,
  Badge,
  Stack,
  Row,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  Label,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "agora/ui";
import { useListQuery } from "agora/ui";
import { type PaginationMeta } from "agora";
import { api } from "@/lib/rpc";
// Types derived from RPC client types
type SessionRow = {
  id: string;
  branchId: string;
  stationId: string;
  memberId: string;
  status: string; // "active" | "paused" | "ended"
  startedAt: string;
  scheduledEndAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  rateSnapshot: string;
  rateSource: string;
  finalAmount: string | null;
  amountCharged: string | null;
  stationName: string;
  stationNumber: string;
  memberName: string;
  memberEmail: string | null;
  createdAt: string;
  
  // These are not actually returned by the API route currently based on inspection
  // pausedDurationSeconds: number;
  // actualBillableSeconds: number | null;
};

type Branch = { id: string; name: string; code: string };
type Station = { id: string; name: string; status: string; branchId: string };

function computeElapsedSeconds(s: SessionRow, nowMs: number): number {
  if (s.status === "ended") {
    if (s.endedAt) {
        return Math.floor((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000);
    }
    return 0;
  }
  
  const start = new Date(s.startedAt).getTime();
  let elapsed = Math.floor((nowMs - start) / 1000);
  
  if (s.status === "paused" && s.pausedAt) {
    const pauseStart = new Date(s.pausedAt).getTime();
    elapsed -= Math.floor((nowMs - pauseStart) / 1000);
  }
  
  return Math.max(0, elapsed);
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export default function SessionsPage() {
  const query = useListQuery(["branchId", "status"]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  
  const [branches, setBranches] = useState<Branch[]>([]);
  const [stations, setStations] = useState<Station[]>([]);

  // Ticking UI state
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const res = await api.rpc.sessions.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
        branchId: query.filters.branchId as string | undefined,
        status: query.filters.status as "active" | "paused" | "ended" | undefined,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setSessions(body.items as SessionRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [
    query.page,
    query.pageSize,
    query.q,
    query.sort,
    query.order,
    query.filters.branchId,
    query.filters.status,
  ]);

  const loadDependencies = useCallback(async () => {
    const [branchesRes, stationsRes] = await Promise.all([
      api.rpc.branches.$get({ query: { page: "1", pageSize: "100" } }),
      api.rpc.stations.$get({ query: { page: "1", pageSize: "1000" } }),
    ]);
    
    if (branchesRes.ok) {
      const b = await branchesRes.json();
      setBranches(b.items as Branch[]);
    }
    
    if (stationsRes.ok) {
      const s = await stationsRes.json();
      setStations(s.items as Station[]);
    }
  }, []);

  useEffect(() => {
    load();
    // Refetch every 10s to keep board relatively fresh
    const interval = setInterval(() => {
      load();
    }, 10000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    loadDependencies();
  }, [loadDependencies]);

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);


  // --- Start Session State ---
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [startForm, setStartForm] = useState({
    stationId: "",
    memberId: "",
    durationMinutes: "",
  });
  const [starting, setStarting] = useState(false);

  function triggerStart() {
    setStartForm({ stationId: "", memberId: "", durationMinutes: "" });
    setStartDialogOpen(true);
  }

  async function submitStart(e: React.FormEvent) {
    e.preventDefault();
    if (!startForm.stationId || !startForm.memberId) return;
    
    setStarting(true);
    const res = await api.rpc.sessions.$post({
      json: {
        stationId: startForm.stationId,
        memberId: startForm.memberId,
        durationMinutes: startForm.durationMinutes ? parseInt(startForm.durationMinutes) : undefined,
      },
    });
    setStarting(false);
    
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? "Could not start session.");
      return;
    }
    
    toast.success("Session started.");
    setStartDialogOpen(false);
    load();
    loadDependencies(); // refresh station status
  }


  // --- Row Actions State ---
  const [actioning, setActioning] = useState(false);
  const [extendDialog, setExtendDialog] = useState<SessionRow | null>(null);
  const [extendMinutes, setExtendMinutes] = useState("");
  const [endDialog, setEndDialog] = useState<SessionRow | null>(null);

  async function handleAction(action: "pause" | "resume", session: SessionRow) {
    setActioning(true);
    const res = await api.rpc.sessions[":id"][action].$post({
      param: { id: session.id },
    });
    setActioning(false);
    
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? `Could not ${action} session.`);
      return;
    }
    
    toast.success(`Session ${action === 'pause' ? 'paused' : 'resumed'}.`);
    load();
  }

  async function submitExtend(e: React.FormEvent) {
    e.preventDefault();
    if (!extendDialog || !extendMinutes) return;
    
    setActioning(true);
    const res = await api.rpc.sessions[":id"].extend.$post({
      param: { id: extendDialog.id },
      json: { minutes: parseInt(extendMinutes) },
    });
    setActioning(false);
    
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? "Could not extend session.");
      return;
    }
    
    toast.success("Session extended.");
    setExtendDialog(null);
    setExtendMinutes("");
    load();
  }

  async function submitEnd(e: React.FormEvent) {
    e.preventDefault();
    if (!endDialog) return;
    
    setActioning(true);
    const res = await api.rpc.sessions[":id"].end.$post({
      param: { id: endDialog.id },
    });
    setActioning(false);
    
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? "Could not end session.");
      return;
    }
    
    toast.success("Session ended.");
    setEndDialog(null);
    load();
    loadDependencies(); // refresh station status
  }

  // --- Rendering ---
  function renderStatus(s: SessionRow) {
    return (
      <Badge variant={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "secondary"}>
        {s.status}
      </Badge>
    );
  }

  function renderActions(s: SessionRow) {
    if (s.status === "ended") return null;
    
    return (
      <Row items="center" shrink>
        {s.status === "active" ? (
          <Button variant="outline" size="sm" onClick={() => handleAction("pause", s)} disabled={actioning}>
            Pause
          </Button>
        ) : s.status === "paused" ? (
          <Button variant="outline" size="sm" onClick={() => handleAction("resume", s)} disabled={actioning}>
            Resume
          </Button>
        ) : null}
        
        <Button variant="outline" size="sm" onClick={() => { setExtendDialog(s); setExtendMinutes(""); }} disabled={actioning}>
          Extend
        </Button>
        
        <Button variant="destructive" size="sm" onClick={() => setEndDialog(s)} disabled={actioning}>
          End
        </Button>
      </Row>
    );
  }

  const columns: DataTableColumn<SessionRow>[] = [
    { key: "status", header: "Status", render: renderStatus },
    { key: "stationName", header: "Station", sortable: true },
    { key: "memberName", header: "Member" },
    { 
      key: "startedAt", 
      header: "Started", 
      sortable: true,
      render: (s) => new Date(s.startedAt).toLocaleString() 
    },
    { 
      key: "duration", 
      header: "Duration", 
      render: (s) => {
        // use 'now' just to trigger re-renders to tick the computed string
        return formatDuration(computeElapsedSeconds(s, now));
      }
    },
    {
      key: "scheduledEndAt",
      header: "Scheduled End",
      render: (s) => s.scheduledEndAt ? new Date(s.scheduledEndAt).toLocaleString() : "—"
    },
    { key: "actions", header: "", render: renderActions },
  ];


  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-muted-foreground">
          Manage station sessions.
        </p>
      </div>

      <Dialog open={startDialogOpen} onOpenChange={setStartDialogOpen}>
        <Row items="center">
          <DialogTrigger asChild>
            <Button onClick={triggerStart}>Start Session</Button>
          </DialogTrigger>
        </Row>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Start session</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitStart} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="stationId">Station</Label>
              <Select
                value={startForm.stationId}
                onValueChange={(v) => setStartForm({ ...startForm, stationId: v })}
              >
                <SelectTrigger id="stationId">
                  <SelectValue placeholder="Select a station" />
                </SelectTrigger>
                <SelectContent>
                  {stations.map((st) => (
                    <SelectItem key={st.id} value={st.id} disabled={st.status !== "available"}>
                      {st.name} {st.status !== "available" ? `(${st.status})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="memberId">Member ID</Label>
              <Input
                id="memberId"
                placeholder="Enter member ID..."
                value={startForm.memberId}
                onChange={(e) => setStartForm({ ...startForm, memberId: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="durationMinutes">Duration (minutes, optional)</Label>
              <Input
                id="durationMinutes"
                type="number"
                min="1"
                max="1440"
                placeholder="e.g. 60"
                value={startForm.durationMinutes}
                onChange={(e) => setStartForm({ ...startForm, durationMinutes: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={starting || !startForm.stationId || !startForm.memberId}>
                {starting ? "Starting…" : "Start session"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      
      {/* Extend Dialog */}
      <Dialog open={!!extendDialog} onOpenChange={(open) => !open && setExtendDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend Session</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitExtend} className="space-y-4">
             <div className="space-y-2">
              <Label htmlFor="extendMinutes">Minutes to extend</Label>
              <Input
                id="extendMinutes"
                type="number"
                min="1"
                max="1440"
                required
                value={extendMinutes}
                onChange={(e) => setExtendMinutes(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setExtendDialog(null)}>Cancel</Button>
              <Button type="submit" disabled={actioning || !extendMinutes}>Extend</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* End Dialog */}
      <Dialog open={!!endDialog} onOpenChange={(open) => !open && setEndDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End Session</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitEnd} className="space-y-4">
             <p>Are you sure you want to end this session on <strong>{endDialog?.stationName}</strong>?</p>
             <p className="text-sm text-muted-foreground">The wallet will be debited for the duration used.</p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEndDialog(null)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={actioning}>End Session</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>


      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search sessions…"
        view={query.view}
        onViewChange={query.setView}
      >
        <Select
          value={(query.filters.branchId as string) || "all"}
          onValueChange={(v) => query.setFilters({ ...query.filters, branchId: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Branches" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Branches</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </DataTableToolbar>

      {query.view === "grid" ? (
        <DataTableGrid
          rows={sessions}
          rowKey={(s) => s.id}
          emptyMessage="No sessions yet."
          renderCard={(s) => (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{s.stationName}</p>
                  <p className="text-xs text-muted-foreground">{s.memberName}</p>
                </div>
                <div className="flex items-center gap-2">
                  {renderStatus(s)}
                </div>
              </div>
              <div className="text-sm">
                Started: {new Date(s.startedAt).toLocaleString()}
              </div>
              <div className="text-sm font-mono tracking-tight">
                {formatDuration(computeElapsedSeconds(s, now))}
              </div>
              <div className="mt-2 flex justify-end">
                {renderActions(s)}
              </div>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={sessions}
          rowKey={(s) => s.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No sessions yet."
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
