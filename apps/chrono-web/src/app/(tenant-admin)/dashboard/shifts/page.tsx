"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
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
import { useSession } from "@/lib/auth-client";

type Shift = {
  id: string;
  tenantId: string;
  branchId: string;
  staffUserId: string;
  staffName: string;
  staffEmail: string;
  status: "open" | "closed";
  openingCashAmount: string;
  openedAt: string;
  closedAt: string | null;
  actualCashAmount: string | null;
  expectedCashAmount: string | null;
  differenceAmount: string | null;
  openNotes: string | null;
  closeNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

type Branch = {
  id: string;
  name: string;
  code: string;
};

export default function ShiftsPage() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closingShift, setClosingShift] = useState<Shift | null>(null);
  const [expectedCashPreview, setExpectedCashPreview] = useState<string | null>(null);
  const [expectedCashPreviewLoading, setExpectedCashPreviewLoading] = useState(false);

  const [openForm, setOpenForm] = useState({ branchId: "", openingCashAmount: "", notes: "" });
  const [closeForm, setCloseForm] = useState({ actualCashAmount: "", notes: "" });
  const [saving, setSaving] = useState(false);
  
  const query = useListQuery();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const load = useCallback(async () => {
    const res = await api.rpc.shifts.$get({
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
      setShifts(body.items as Shift[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  const loadBranches = useCallback(async () => {
    // Only need a lightweight list of branches to populate the select.
    const res = await api.rpc.branches.$get({
      query: { page: "1", pageSize: "100" },
    });
    if (res.ok) {
      const body = await res.json();
      setBranches(body.items as Branch[]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  function triggerOpen() {
    setOpenForm({ branchId: "", openingCashAmount: "", notes: "" });
    setOpenDialogOpen(true);
  }

  function triggerClose(s: Shift) {
    setClosingShift(s);
    setCloseForm({ actualCashAmount: "", notes: "" });
    setExpectedCashPreview(null);
    setCloseDialogOpen(true);
    setExpectedCashPreviewLoading(true);
    api.rpc.reconciliation.shifts[":id"].$get({ param: { id: s.id } }).then(async (res) => {
      if (res.ok) {
        const body = await res.json();
        setExpectedCashPreview(body.summary.expectedCashAmount);
      }
      setExpectedCashPreviewLoading(false);
    });
  }

  async function submitOpen(e: React.FormEvent) {
    e.preventDefault();
    if (!openForm.branchId || !openForm.openingCashAmount.trim()) return;
    setSaving(true);
    const res = await api.rpc.shifts.open.$post({ 
      json: {
        branchId: openForm.branchId,
        openingCashAmount: openForm.openingCashAmount.trim(),
        notes: openForm.notes.trim() || undefined,
      } 
    });
    setSaving(false);
    if (!res.ok) {
      if ((res.status as number) === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "You already have an open shift at this branch.");
      } else {
        toast.error("Could not open shift.");
      }
      return;
    }
    toast.success("Shift opened.");
    setOpenDialogOpen(false);
    load();
  }

  async function submitClose(e: React.FormEvent) {
    e.preventDefault();
    if (!closingShift || !closeForm.actualCashAmount.trim()) return;
    setSaving(true);
    const res = await api.rpc.shifts[":id"].close.$post({
      param: { id: closingShift.id },
      json: {
        actualCashAmount: closeForm.actualCashAmount.trim(),
        notes: closeForm.notes.trim() || undefined,
      },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not close shift.");
      return;
    }
    toast.success("Shift closed.");
    setCloseDialogOpen(false);
    load();
  }

  function renderStatus(s: Shift) {
    return (
      <Badge variant={s.status === "open" ? "success" : "secondary"}>
        {s.status === "open" ? "Open" : "Closed"}
      </Badge>
    );
  }

  function renderActions(s: Shift) {
    if (s.status === "open" && s.staffUserId === userId) {
      return (
        <Row items="center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => triggerClose(s)}
          >
            Close Shift
          </Button>
        </Row>
      );
    }
    return null;
  }
  
  function getBranchName(branchId: string) {
    const b = branches.find((b) => b.id === branchId);
    return b ? b.name : branchId;
  }

  const columns: DataTableColumn<Shift>[] = [
    { key: "status", header: "Status", render: renderStatus },
    { key: "staffName", header: "Staff", render: (s) => s.staffName },
    { key: "branchId", header: "Branch", render: (s) => getBranchName(s.branchId) },
    {
      key: "openedAt",
      header: "Opened",
      sortable: true,
      render: (s) => new Date(s.openedAt).toLocaleString(),
    },
    {
      key: "closedAt",
      header: "Closed",
      sortable: true,
      render: (s) => s.closedAt ? new Date(s.closedAt).toLocaleString() : "—",
    },
    { key: "openingCashAmount", header: "Opening Cash", render: (s) => s.openingCashAmount },
    { key: "actualCashAmount", header: "Actual Cash", render: (s) => s.actualCashAmount ?? "—" },
    {
      key: "expectedVariance",
      header: "Expected / Variance",
      render: (s) =>
        s.expectedCashAmount == null
          ? "—"
          : `${s.expectedCashAmount} / ${s.differenceAmount ?? "—"}`,
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shifts</h1>
        <p className="text-sm text-muted-foreground">
          Cash-drawer sessions.
        </p>
      </div>

      <Dialog open={openDialogOpen} onOpenChange={setOpenDialogOpen}>
        <Row items="center">
          <DialogTrigger asChild>
            <Button onClick={triggerOpen}>Open Shift</Button>
          </DialogTrigger>
        </Row>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Open shift</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitOpen} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="branchId">Branch</Label>
              <Select
                value={openForm.branchId}
                onValueChange={(v) => setOpenForm({ ...openForm, branchId: v })}
              >
                <SelectTrigger id="branchId">
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="openingCashAmount">Opening cash</Label>
              <Input
                id="openingCashAmount"
                type="text"
                placeholder="0.00"
                value={openForm.openingCashAmount}
                onChange={(e) => setOpenForm({ ...openForm, openingCashAmount: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={openForm.notes}
                onChange={(e) => setOpenForm({ ...openForm, notes: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={saving || !openForm.branchId}>
                {saving ? "Opening…" : "Open shift"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      
      <Dialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Close shift</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitClose} className="space-y-4">
            <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Expected cash: </span>
              <span className="font-medium">
                {expectedCashPreviewLoading
                  ? "Calculating…"
                  : (expectedCashPreview ?? "—")}
              </span>
            </div>
            <div className="space-y-2">
              <Label htmlFor="actualCashAmount">Actual cash counted</Label>
              <Input
                id="actualCashAmount"
                type="text"
                placeholder="0.00"
                value={closeForm.actualCashAmount}
                onChange={(e) => setCloseForm({ ...closeForm, actualCashAmount: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="closeNotes">Notes</Label>
              <Input
                id="closeNotes"
                value={closeForm.notes}
                onChange={(e) => setCloseForm({ ...closeForm, notes: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "Closing…" : "Close shift"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search shifts…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={shifts}
          rowKey={(s) => s.id}
          emptyMessage="No shifts yet."
          renderCard={(s) => (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{s.staffName}</p>
                  <p className="text-xs text-muted-foreground">{getBranchName(s.branchId)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {renderStatus(s)}
                </div>
              </div>
              <div className="text-sm">
                Opened: {new Date(s.openedAt).toLocaleString()}
              </div>
              <div className="text-sm">
                Cash: {s.actualCashAmount ?? s.openingCashAmount}
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
          rows={shifts}
          rowKey={(s) => s.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No shifts yet."
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
