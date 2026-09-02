"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Label,
  Textarea,
  Badge,
  Stack,
  Row,
  Can,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
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
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type Severity = "low" | "medium" | "high" | "critical";
type AlertType =
  | "device_tamper"
  | "unauthorized_access"
  | "unexpected_shutdown"
  | "chassis_open"
  | "camera_flagged"
  | "customer_dispute"
  | "theft_suspected"
  | "other";
type Status = "open" | "acknowledged" | "resolved";

type SecurityAlert = {
  id: string;
  branchId: string;
  stationId: string | null;
  raisedBy: string;
  severity: Severity;
  type: AlertType;
  message: string;
  status: Status;
  resolutionNote: string | null;
  createdAt: string;
};

type Branch = { id: string; name: string };
type Me = { permissions: Record<string, string[]> };

const FILTER_KEYS = ["branchId", "status", "severity"];

const SEVERITY_VARIANT: Record<Severity, "default" | "secondary" | "destructive" | "success" | "warning"> = {
  low: "secondary",
  medium: "default",
  high: "warning",
  critical: "destructive",
};

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "destructive" | "success" | "warning"> = {
  open: "destructive",
  acknowledged: "warning",
  resolved: "success",
};

const TYPE_OPTIONS: { value: AlertType; label: string }[] = [
  { value: "device_tamper", label: "Device tamper" },
  { value: "unauthorized_access", label: "Unauthorized access" },
  { value: "unexpected_shutdown", label: "Unexpected shutdown" },
  { value: "chassis_open", label: "Chassis open" },
  { value: "camera_flagged", label: "Camera flagged" },
  { value: "customer_dispute", label: "Customer dispute" },
  { value: "theft_suspected", label: "Theft suspected" },
  { value: "other", label: "Other" },
];

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export default function SecurityAlertsPage() {
  const query = useListQuery(FILTER_KEYS);
  const branchId = query.filters.branchId ?? "";
  const status = query.filters.status ?? "";
  const severity = query.filters.severity ?? "";

  const [branches, setBranches] = useState<Branch[]>([]);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const [resolveTarget, setResolveTarget] = useState<SecurityAlert | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolving, setResolving] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportBranchId, setReportBranchId] = useState("");
  const [reportSeverity, setReportSeverity] = useState<Severity>("medium");
  const [reportType, setReportType] = useState<AlertType>("other");
  const [reportMessage, setReportMessage] = useState("");
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.branches.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setBranches(body.items as Branch[]);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  const load = useCallback(async () => {
    const res = await api.rpc["security-alerts"].$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
        ...(branchId ? { branchId } : {}),
        ...(status ? { status: status as Status } : {}),
        ...(severity ? { severity: severity as Severity } : {}),
      },
    });
    if (res.ok) {
      const body = await res.json();
      setAlerts(body.items as SecurityAlert[]);
      setMeta(body.meta as PaginationMeta);
    } else {
      setAlerts([]);
      setMeta(null);
    }
  }, [branchId, status, severity, query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  function branchName(id: string): string {
    return branches.find((b) => b.id === id)?.name ?? id;
  }

  async function acknowledge(alert: SecurityAlert) {
    const res = await api.rpc["security-alerts"][":id"].acknowledge.$post({
      param: { id: alert.id },
    });
    if (!res.ok) {
      toast.error(await extractError(res, "Could not acknowledge this alert."));
      return;
    }
    toast.success("Alert acknowledged.");
    load();
  }

  function openResolve(alert: SecurityAlert) {
    setResolveTarget(alert);
    setResolutionNote("");
  }

  async function submitResolve(e: React.FormEvent) {
    e.preventDefault();
    if (!resolveTarget || !resolutionNote.trim()) return;
    setResolving(true);
    const res = await api.rpc["security-alerts"][":id"].resolve.$post({
      param: { id: resolveTarget.id },
      json: { resolutionNote: resolutionNote.trim() },
    });
    setResolving(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not resolve this alert."));
      return;
    }
    toast.success("Alert resolved.");
    setResolveTarget(null);
    load();
  }

  function openReport() {
    setReportBranchId(branchId || branches[0]?.id || "");
    setReportSeverity("medium");
    setReportType("other");
    setReportMessage("");
    setReportOpen(true);
  }

  async function submitReport(e: React.FormEvent) {
    e.preventDefault();
    if (!reportBranchId || !reportMessage.trim()) return;
    setReporting(true);
    const res = await api.rpc["security-alerts"].$post({
      json: {
        branchId: reportBranchId,
        severity: reportSeverity,
        type: reportType,
        message: reportMessage.trim(),
      },
    });
    setReporting(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not report this incident."));
      return;
    }
    toast.success("Incident reported.");
    setReportOpen(false);
    load();
  }

  function renderActions(a: SecurityAlert) {
    if (a.status === "resolved") {
      return null;
    }
    return (
      <Row items="center">
        {a.status === "open" ? (
          <Can permissions={me?.permissions} resource="securityAlert" action="manage">
            <Button variant="ghost" size="sm" onClick={() => acknowledge(a)}>
              Acknowledge
            </Button>
          </Can>
        ) : null}
        <Can permissions={me?.permissions} resource="securityAlert" action="manage">
          <Button variant="ghost" size="sm" onClick={() => openResolve(a)}>
            Resolve
          </Button>
        </Can>
      </Row>
    );
  }

  const columns: DataTableColumn<SecurityAlert>[] = [
    {
      key: "createdAt",
      header: "Reported",
      sortable: true,
      render: (a) => new Date(a.createdAt).toLocaleString(),
    },
    { key: "branch", header: "Branch", render: (a) => branchName(a.branchId) },
    {
      key: "severity",
      header: "Severity",
      sortable: true,
      render: (a) => <Badge variant={SEVERITY_VARIANT[a.severity]}>{a.severity}</Badge>,
    },
    { key: "type", header: "Type", render: (a) => a.type.replace(/_/g, " ") },
    { key: "message", header: "Message", render: (a) => a.message },
    {
      key: "status",
      header: "Status",
      render: (a) => <Badge variant={STATUS_VARIANT[a.status]}>{a.status}</Badge>,
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack>
      <Row items="center" className="justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Security Alerts</h1>
          <p className="text-sm text-muted-foreground">
            Device-tamper, access, and incident reports across your branches.
          </p>
        </div>
        <Dialog open={reportOpen} onOpenChange={setReportOpen}>
          <DialogTrigger asChild>
            <Can permissions={me?.permissions} resource="securityAlert" action="manage">
              <Button onClick={openReport}>Report Incident</Button>
            </Can>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Report incident</DialogTitle>
            </DialogHeader>
            <form onSubmit={submitReport} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="report-branch">Branch</Label>
                <Select value={reportBranchId} onValueChange={setReportBranchId}>
                  <SelectTrigger id="report-branch">
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="report-severity">Severity</Label>
                  <Select
                    value={reportSeverity}
                    onValueChange={(v) => setReportSeverity(v as Severity)}
                  >
                    <SelectTrigger id="report-severity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="report-type">Type</Label>
                  <Select value={reportType} onValueChange={(v) => setReportType(v as AlertType)}>
                    <SelectTrigger id="report-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_OPTIONS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="report-message">Message</Label>
                <Textarea
                  id="report-message"
                  value={reportMessage}
                  onChange={(e) => setReportMessage(e.target.value)}
                  required
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={reporting}>
                  {reporting ? "Reporting…" : "Report incident"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </Row>

      <Dialog
        open={!!resolveTarget}
        onOpenChange={(open) => {
          if (!open) setResolveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve alert</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitResolve} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="resolution-note">Resolution note</Label>
              <Textarea
                id="resolution-note"
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={resolving || !resolutionNote.trim()}>
                {resolving ? "Resolving…" : "Resolve"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Row items="center">
        <div className="w-56">
          <Select
            value={branchId || "all"}
            onValueChange={(v) => query.setFilters({ branchId: v === "all" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All branches" />
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
        <div className="w-44">
          <Select
            value={status || "all"}
            onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="acknowledged">Acknowledged</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={severity || "all"}
            onValueChange={(v) => query.setFilters({ severity: v === "all" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All severities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Row>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search alerts…"
        view={query.view}
        onViewChange={query.setView}
      />

      <DataTable
        columns={columns}
        rows={alerts}
        rowKey={(a) => a.id}
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
        emptyMessage="No security alerts."
      />

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
