"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  Badge,
  Button,
  Stack,
  Row,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  DataTableToolbar,
  useListQuery,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Label,
  Input,
  Can,
  toast,
} from "agora/ui";
import { api } from "@/lib/rpc";
import { connectChronoRealtime, onStationStatus, onSessionState } from "@/lib/realtime";
import type { StationStatusEvent, SessionStateEvent } from "@agora/chrono-api/realtime";
import type { StationBoardStation, StationBoardSession } from "@agora/chrono-api/station";
import { computeElapsedSeconds, computeRemainingSeconds, formatDuration } from "@/lib/session-time";

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

const STATUS_BADGE_VARIANT: Record<
  StationBoardStation["status"],
  "success" | "default" | "warning" | "secondary" | "destructive"
> = {
  available: "success",
  occupied: "default",
  maintenance: "secondary",
  offline: "destructive",
};

// Realtime bursts (e.g. many sessions ending at once) coalesce into one
// refetch instead of one per event; the interval poll is a floor, not a
// ceiling, reconciling anything a missed/duplicate realtime event would
// otherwise leave stale.
const REFETCH_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 15000;

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/**
 * `startSession` (session/service.ts) can fail three distinct ways from this
 * card's "Start" action: 400 "no pricing group" (an ungrouped/"Unassigned
 * Stations" card), 409 "STATION_OCCUPIED" (a reservation hold claimed it, or
 * another staff member just started a session on it), and 422 "insufficient
 * wallet balance". The 400/422 messages are already reader-friendly
 * sentences from the server; only the 409 is a bare code string (matching
 * `sessions/page.tsx`'s own existing convention for the same route), so it
 * gets a friendlier message here rather than showing "STATION_OCCUPIED"
 * verbatim in a toast.
 */
function friendlyStartError(message: string): string {
  return message === "STATION_OCCUPIED"
    ? "This station was just taken — pick another one."
    : message;
}

function renderSessionTime(session: StationBoardSession, nowMs: number) {
  if (session.scheduledEndAt) {
    const remaining = computeRemainingSeconds(session.scheduledEndAt, nowMs);
    const overdue = remaining <= 0;
    return (
      <span className={overdue ? "font-mono text-sm font-semibold text-destructive" : "font-mono text-sm"}>
        {overdue ? "Overdue" : formatDuration(remaining)}
      </span>
    );
  }
  const elapsed = computeElapsedSeconds(
    { status: session.status, startedAt: session.startedAt, pausedAt: session.pausedAt },
    nowMs,
  );
  return <span className="font-mono text-sm">{formatDuration(elapsed)}</span>;
}

type StationGroupBucket = {
  id: string | null;
  label: string;
  stations: StationBoardStation[];
};

/**
 * Station Control board — every station for the selected branch, grouped by
 * its station group, with live session state on the card. See
 * `.ai/plans/chrono/active/station-control-grouping/README.md`, Phase 3.
 * Transfer is deliberately not implemented in this pass (Open Question 1,
 * resolved as "deferred") — the card omits it entirely rather than showing
 * it disabled.
 */
export function StationControlBoard({ branchId }: { branchId: string | undefined }) {
  const [me, setMe] = useState<Me | null>(null);
  const [stations, setStations] = useState<StationBoardStation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Group/status filters are URL-persisted via useListQuery, but the
  // search box deliberately is NOT: useListQuery writes a bare `q` URL key
  // with no namespacing, and the page also runs its own useListQuery
  // (branchId) for the "Manage Stations"/"Groups & Rates" tabs — sharing
  // the `q` key across two independent useListQuery instances on one page
  // would let a search typed in one clobber/leak into the other on the
  // next full read of the URL. A plain local state avoids that collision.
  const query = useListQuery(["groupId", "status"]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  const loadBoard = useCallback(async () => {
    if (!branchId) {
      setStations([]);
      setLoaded(true);
      return;
    }
    const res = await (api.rpc as any).stations.board.$get({ query: { branchId } });
    if (res.ok) {
      const body = await res.json();
      setStations(body.stations as StationBoardStation[]);
    }
    setLoaded(true);
  }, [branchId]);

  useEffect(() => {
    setLoaded(false);
    loadBoard();
  }, [loadBoard]);

  // 15s poll fallback/reconciliation — a floor, not a ceiling; realtime
  // events (below) already trigger a debounced refetch on their own.
  useEffect(() => {
    if (!branchId) return;
    const interval = setInterval(loadBoard, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [branchId, loadBoard]);

  // 1s tick to keep the live timers moving.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Realtime: patch station.status immediately for a snappy badge flip, and
  // debounce a full board refetch on either station.status or session.state
  // to pick up member/timer detail (see the plan's architecture decision on
  // why the shared session.state payload isn't widened instead).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!branchId) return;
    const connection = connectChronoRealtime([`branch:${branchId}`]);

    function scheduleRefetch() {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        loadBoard();
      }, REFETCH_DEBOUNCE_MS);
    }

    const offStatus = onStationStatus(connection, (event: StationStatusEvent) => {
      setStations((prev) =>
        prev.map((s) => (s.id === event.stationId ? { ...s, status: event.status } : s)),
      );
      scheduleRefetch();
    });
    const offSession = onSessionState(connection, (_event: SessionStateEvent) => {
      scheduleRefetch();
    });

    return () => {
      offStatus();
      offSession();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      connection.close();
    };
  }, [branchId, loadBoard]);

  const groups = useMemo<StationGroupBucket[]>(() => {
    const byGroup = new Map<string, StationGroupBucket>();
    for (const s of stations) {
      const key = s.stationGroupId ?? "unassigned";
      if (!byGroup.has(key)) {
        byGroup.set(key, {
          id: s.stationGroupId,
          label: s.stationGroupName ?? "Unassigned Stations",
          stations: [],
        });
      }
      byGroup.get(key)!.stations.push(s);
    }
    const list = [...byGroup.values()];
    // Alphabetical by label, "Unassigned Stations" always last (MVP — no
    // sortOrder column, see the plan's Open Question 3).
    list.sort((a, b) => {
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return a.label.localeCompare(b.label);
    });
    for (const g of list) {
      g.stations.sort((a, b) =>
        a.stationNumber.localeCompare(b.stationNumber, undefined, { numeric: true }),
      );
    }
    return list;
  }, [stations]);

  const groupOptions = useMemo(() => {
    const byId = new Map<string, string>();
    let hasUnassigned = false;
    for (const s of stations) {
      if (s.stationGroupId) byId.set(s.stationGroupId, s.stationGroupName ?? s.stationGroupId);
      else hasUnassigned = true;
    }
    const opts = [...byId.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (hasUnassigned) opts.push({ id: "unassigned", label: "Unassigned Stations" });
    return opts;
  }, [stations]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groupFilter = query.filters.groupId;
    const statusFilter = query.filters.status;
    return groups
      .filter((g) => {
        if (!groupFilter) return true;
        return groupFilter === "unassigned" ? g.id === null : g.id === groupFilter;
      })
      .map((g) => ({
        ...g,
        stations: g.stations.filter((s) => {
          if (statusFilter && s.status !== statusFilter) return false;
          if (!q) return true;
          return (
            s.stationNumber.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            (s.stationGroupName ?? "unassigned stations").toLowerCase().includes(q) ||
            s.status.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((g) => g.stations.length > 0);
  }, [groups, search, query.filters.groupId, query.filters.status]);

  // --- Start session dialog ------------------------------------------------
  const [startStation, setStartStation] = useState<StationBoardStation | null>(null);
  const [startForm, setStartForm] = useState({ memberId: "", durationMinutes: "" });
  const [starting, setStarting] = useState(false);

  function openStart(s: StationBoardStation) {
    setStartForm({ memberId: "", durationMinutes: "" });
    setStartStation(s);
  }

  async function submitStart(e: React.FormEvent) {
    e.preventDefault();
    if (!startStation || !startForm.memberId.trim()) return;
    setStarting(true);
    const res = await api.rpc.sessions.$post({
      json: {
        stationId: startStation.id,
        memberId: startForm.memberId.trim(),
        durationMinutes: startForm.durationMinutes
          ? parseInt(startForm.durationMinutes, 10)
          : undefined,
      },
    });
    setStarting(false);
    if (!res.ok) {
      toast.error(friendlyStartError(await extractError(res, "Could not start session.")));
      return;
    }
    toast.success("Session started.");
    setStartStation(null);
    loadBoard();
  }

  // --- Pause / Resume / End / Extend ---------------------------------------
  const [actioning, setActioning] = useState(false);
  const [extendSessionId, setExtendSessionId] = useState<string | null>(null);
  const [extendMinutes, setExtendMinutes] = useState("");
  const [endSessionId, setEndSessionId] = useState<string | null>(null);

  async function handleAction(action: "pause" | "resume", sessionId: string) {
    setActioning(true);
    const res = await api.rpc.sessions[":id"][action].$post({ param: { id: sessionId } });
    setActioning(false);
    if (!res.ok) {
      toast.error(await extractError(res, `Could not ${action} session.`));
      return;
    }
    toast.success(action === "pause" ? "Session paused." : "Session resumed.");
    loadBoard();
  }

  async function submitExtend(e: React.FormEvent) {
    e.preventDefault();
    if (!extendSessionId || !extendMinutes) return;
    setActioning(true);
    const res = await api.rpc.sessions[":id"].extend.$post({
      param: { id: extendSessionId },
      json: { minutes: parseInt(extendMinutes, 10) },
    });
    setActioning(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not extend session."));
      return;
    }
    toast.success("Session extended.");
    setExtendSessionId(null);
    setExtendMinutes("");
    loadBoard();
  }

  async function submitEnd(e: React.FormEvent) {
    e.preventDefault();
    if (!endSessionId) return;
    setActioning(true);
    const res = await api.rpc.sessions[":id"].end.$post({ param: { id: endSessionId } });
    setActioning(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not end session."));
      return;
    }
    toast.success("Session ended.");
    setEndSessionId(null);
    loadBoard();
  }

  function renderActions(s: StationBoardStation) {
    if (s.status === "maintenance" || s.status === "offline") return null;

    if (!s.activeSession) {
      if (s.status !== "available") return null;
      return (
        <Can permissions={me?.permissions} resource="session" action="create">
          <Button size="sm" onClick={() => openStart(s)}>
            Start
          </Button>
        </Can>
      );
    }

    const session = s.activeSession;
    return (
      <Can permissions={me?.permissions} resource="session" action="update">
        <Row gap={2} wrap>
          {session.status === "active" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={actioning}
              onClick={() => handleAction("pause", session.id)}
            >
              Pause
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={actioning}
              onClick={() => handleAction("resume", session.id)}
            >
              Resume
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={actioning}
            onClick={() => {
              setExtendMinutes("");
              setExtendSessionId(session.id);
            }}
          >
            Add Time
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={actioning}
            onClick={() => setEndSessionId(session.id)}
          >
            End
          </Button>
        </Row>
      </Can>
    );
  }

  function renderStationCard(s: StationBoardStation) {
    return (
      <Card key={s.id} className="p-3" data-testid={`station-board-card-${s.id}`}>
        <Stack gap={2}>
          <Row justify="between" items="start">
            <div>
              <p className="text-2xl font-bold leading-none">{s.stationNumber}</p>
              <p className="text-xs text-muted-foreground">{s.name}</p>
            </div>
            <Badge variant={s.activeSession?.status === "paused" ? "warning" : STATUS_BADGE_VARIANT[s.status]}>
              {s.activeSession?.status === "paused" ? "paused" : s.status}
            </Badge>
          </Row>
          {s.activeSession ? (
            <Stack gap={1}>
              <p className="truncate text-sm font-medium">{s.activeSession.memberName}</p>
              {renderSessionTime(s.activeSession, now)}
            </Stack>
          ) : null}
          {renderActions(s)}
        </Stack>
      </Card>
    );
  }

  if (!branchId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Select a branch to see its stations.
        </CardContent>
      </Card>
    );
  }

  return (
    <Stack gap={4}>
      <DataTableToolbar
        q={search}
        onQChange={setSearch}
        searchPlaceholder="Search by station name…"
      >
        <Select
          value={query.filters.groupId || "all"}
          onValueChange={(v) => query.setFilters({ groupId: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Groups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Groups</SelectItem>
            {groupOptions.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.filters.status || "all"}
          onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="occupied">Occupied</SelectItem>
            <SelectItem value="maintenance">Maintenance</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      {loaded && filteredGroups.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No stations match.
          </CardContent>
        </Card>
      ) : (
        filteredGroups.map((g) => (
          <Stack key={g.id ?? "unassigned"} gap={2}>
            <h3 className="text-sm font-semibold text-muted-foreground">
              {g.label} — {g.stations.length} Station{g.stations.length === 1 ? "" : "s"}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {g.stations.map((s) => renderStationCard(s))}
            </div>
          </Stack>
        ))
      )}

      {/* Start session dialog */}
      <Dialog open={startStation !== null} onOpenChange={(open) => !open && setStartStation(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Start session — {startStation ? `${startStation.stationNumber}: ${startStation.name}` : ""}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitStart} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="board-memberId">Member ID</Label>
              <Input
                id="board-memberId"
                placeholder="Enter member ID…"
                value={startForm.memberId}
                onChange={(e) => setStartForm({ ...startForm, memberId: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="board-durationMinutes">Duration (minutes, optional)</Label>
              <Input
                id="board-durationMinutes"
                type="number"
                min="1"
                max="1440"
                placeholder="e.g. 60"
                value={startForm.durationMinutes}
                onChange={(e) => setStartForm({ ...startForm, durationMinutes: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={starting || !startForm.memberId.trim()}>
                {starting ? "Starting…" : "Start session"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Time dialog */}
      <Dialog
        open={extendSessionId !== null}
        onOpenChange={(open) => !open && setExtendSessionId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add time</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitExtend} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="board-extendMinutes">Minutes to add</Label>
              <Input
                id="board-extendMinutes"
                type="number"
                min="1"
                max="1440"
                required
                value={extendMinutes}
                onChange={(e) => setExtendMinutes(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setExtendSessionId(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={actioning || !extendMinutes}>
                Add time
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* End session dialog */}
      <Dialog open={endSessionId !== null} onOpenChange={(open) => !open && setEndSessionId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End session</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitEnd} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The wallet will be debited for the duration used.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEndSessionId(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={actioning}>
                End session
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
