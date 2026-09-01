"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MoreVertical, Copy, Check } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Button,
  Badge,
  Label,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Row,
  Stack,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { usePlatformPermissions } from "../layout";
import type { PaginationMeta, PlatformOrgSummary } from "agora";

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

type OrgSummary = PlatformOrgSummary;

// URL-state filter keys (see .ai/rules/data-listing.md). All list state lives in
// the query string via useListQuery, never local component state.
const FILTER_KEYS = ["status", "planId", "tenantType", "createdFrom", "createdTo"];

const STATUS_VARIANTS: Record<
  OrgSummary["status"],
  "default" | "secondary" | "outline" | "success" | "warning"
> = {
  active: "success",
  trial: "default",
  pending: "secondary",
  suspended: "warning",
  cancelled: "warning",
  archived: "outline",
  deleting: "warning",
};

const STATUS_OPTIONS: OrgSummary["status"][] = [
  "active",
  "trial",
  "pending",
  "suspended",
  "cancelled",
  "archived",
];
const PLAN_OPTIONS = ["free", "pro", "enterprise"] as const;
const TENANT_TYPE_OPTIONS = ["individual", "company", "internal"] as const;

// A sentinel Select value meaning "no filter" — Radix Select cannot use "".
const ANY = "__any__";

function TenantIdCell({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Row gap={1} className="items-center">
      <span className="font-mono text-xs text-muted-foreground">
        {id.slice(0, 8)}…
      </span>
      <Button
        variant="outline"
        size="icon"
        className="h-6 w-6 text-muted-foreground hover:text-foreground border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
        onClick={() => {
          void navigator.clipboard?.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        aria-label="Copy tenant id"
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </Button>
    </Row>
  );
}

export default function PlatformAdminOrganizationsPage() {
  const permissions = usePlatformPermissions();
  const query = useListQuery(FILTER_KEYS);
  const [items, setItems] = useState<OrgSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
    
  const [confirmTarget, setConfirmTarget] = useState<{
    org: OrgSummary;
    action: "suspend" | "archive";
  } | null>(null);
  const [editTarget, setEditTarget] = useState<OrgSummary | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    tenantType: "company" as OrgSummary["tenantType"],
    contactEmail: "",
    contactPhone: "",
  });
  const [planTarget, setPlanTarget] = useState<OrgSummary | null>(null);
  const [planChoice, setPlanChoice] = useState<(typeof PLAN_OPTIONS)[number]>("free");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setLoading(true);
      const res = await adminApi["rpc-admin"].organizations.$get({
        query: {
          page: String(query.page),
          pageSize: String(query.pageSize),
          ...(query.q ? { q: query.q } : {}),
          ...(query.sort ? { sort: query.sort, order: query.order } : {}),
          ...query.filters,
        },
      });
      if (signal.cancelled) return;
      setLoading(false);
      if (!res.ok) {
        toast.error("Could not load organizations.");
        return;
      }
      const body = await res.json();
      setItems(body.items as OrgSummary[]);
      setMeta(body.meta as PaginationMeta);
    },
    [query.page, query.pageSize, query.q, query.sort, query.order, query.filters],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  async function performConfirm() {
    if (!confirmTarget) return;
            const { org, action } = confirmTarget;
    const res = await adminApi["rpc-admin"].organizations[":id"][action].$post({
      param: { id: org.id },
    });
    setConfirmTarget(null);
    handleResult(res, `${org.name} ${action === "suspend" ? "suspended" : "archived"}.`);
  }

  async function reactivate(org: OrgSummary) {
            const res = await adminApi["rpc-admin"].organizations[":id"].reactivate.$post({
      param: { id: org.id },
    });
    handleResult(res, `${org.name} reactivated.`);
  }

  async function submitEdit() {
    if (!editTarget) return;
    setSaving(true);
            const res = await adminApi["rpc-admin"].organizations[":id"].$patch({
      param: { id: editTarget.id },
      json: {
        name: editForm.name.trim(),
        tenantType: editForm.tenantType,
        contactEmail: editForm.contactEmail.trim(),
        contactPhone: editForm.contactPhone.trim(),
      },
    });
    setSaving(false);
    setEditTarget(null);
    handleResult(res, `${editTarget.name} updated.`);
  }

  async function submitPlan() {
    if (!planTarget) return;
    setSaving(true);
            const res = await adminApi["rpc-admin"].organizations[":id"].plan.$patch({
      param: { id: planTarget.id },
      json: { planId: planChoice },
    });
    setSaving(false);
    setPlanTarget(null);
    handleResult(res, `${planTarget.name} moved to the ${planChoice} plan.`);
  }

  async function impersonateOwner(org: OrgSummary) {
    if (!org.ownerId) {
      toast.error("This organization has no owner to impersonate.");
      return;
    }
        const res = await adminApi["rpc-admin"].impersonation.start.$post({
      json: { targetUserId: org.ownerId },
    });
    if (res.ok) {
      window.location.href = `${window.location.protocol}//${org.slug}.${APP_DOMAIN}/dashboard`;
      return;
    }
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not start impersonation.");
  }

  function handleResult(
    res: { ok: boolean; status: number; json: () => Promise<unknown> },
    successMessage: string,
  ) {
    if (res.ok) {
      toast.success(successMessage);
      load({ cancelled: false });
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      void res
        .json()
        .then((b) => toast.error((b as { error?: string })?.error ?? "Could not complete the action."))
        .catch(() => toast.error("Could not complete the action."));
    }
  }

  function openEdit(org: OrgSummary) {
    setEditForm({
      name: org.name,
      tenantType: org.tenantType,
      contactEmail: "",
      contactPhone: "",
    });
    setEditTarget(org);
  }

  function openPlan(org: OrgSummary) {
    setPlanChoice(org.planId);
    setPlanTarget(org);
  }

  const isBlocked = (s: OrgSummary["status"]) =>
    s === "suspended" || s === "archived" || s === "cancelled";

  const columns: DataTableColumn<OrgSummary>[] = [
    {
      key: "name",
      header: "Organization",
      sortable: true,
      render: (org) => (
        <Stack gap={0}>
          <Link
            href={`/admin/organizations/${org.id}`}
            className="font-medium hover:underline"
          >
            {org.name}
          </Link>
          <span className="text-xs text-muted-foreground">{org.slug}</span>
        </Stack>
      ),
    },
    { key: "tenantId", header: "Tenant ID", render: (org) => <TenantIdCell id={org.id} /> },
    {
      key: "owner",
      header: "Owner",
      render: (org) =>
        org.ownerEmail ? (
          <Stack gap={0}>
            <span className="text-sm">{org.ownerName ?? "—"}</span>
            <span className="text-xs text-muted-foreground">{org.ownerEmail}</span>
          </Stack>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "plan",
      header: "Plan",
      render: (org) => (
        <Row gap={2} className="items-center">
          <Badge variant="secondary">{org.planId}</Badge>
          <span className="text-xs text-muted-foreground">${org.estMrr}/mo est.</span>
        </Row>
      ),
    },
    { key: "memberCount", header: "Users", sortable: true, render: (org) => org.memberCount },
    {
      key: "status",
      header: "Status",
      render: (org) => (
        <Badge variant={STATUS_VARIANTS[org.status]}>{org.status}</Badge>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (org) => new Date(org.createdAt).toLocaleDateString(),
    },
    {
      key: "lastActivityAt",
      header: "Last Activity",
      sortable: true,
      render: (org) =>
        org.lastActivityAt ? new Date(org.lastActivityAt).toLocaleDateString() : "—",
    },
    {
      key: "actions",
      header: "",
      render: (org) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              aria-label="Organization actions"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/admin/organizations/${org.id}`}>View</Link>
            </DropdownMenuItem>
            {can("organization", "edit") && (
              <DropdownMenuItem onSelect={() => openEdit(org)}>Edit</DropdownMenuItem>
            )}
            {can("impersonation", "start") && (
              <DropdownMenuItem
                disabled={!org.ownerId}
                onSelect={() => impersonateOwner(org)}
              >
                Impersonate owner
              </DropdownMenuItem>
            )}
            {can("organization", "override_subscription") && (
              <DropdownMenuItem onSelect={() => openPlan(org)}>
                Change plan
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {isBlocked(org.status)
              ? can("organization", "resume") && (
                  <DropdownMenuItem onSelect={() => reactivate(org)}>
                    Reactivate
                  </DropdownMenuItem>
                )
              : can("organization", "suspend") && (
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => setConfirmTarget({ org, action: "suspend" })}
                  >
                    Suspend
                  </DropdownMenuItem>
                )}
            {org.status !== "archived" &&
              can("organization", "archive") && (
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => setConfirmTarget({ org, action: "archive" })}
                >
                  Archive
                </DropdownMenuItem>
              )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  // Local visibility helper mirroring <Can> for use inside the actions menu,
  // where wrapping each item in <Can> would break the menu's keyboard nav.
  function can(resource: string, action: string): boolean {
    return (permissions?.[resource] ?? []).includes(action);
  }

  const setFilter = (key: string, value: string) =>
    query.setFilters({ [key]: value === ANY ? undefined : value });

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="text-sm text-muted-foreground">
          Every tenant on the platform.
        </p>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="py-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Super Admin view.</span> This
            is a platform-wide, cross-tenant surface. Actions here affect any tenant.
            A Tenant Admin, by contrast, only ever sees and manages their own
            organization from <code className="text-xs">/dashboard/settings</code>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All organizations</CardTitle>
          <CardDescription>Search, filter, and manage every tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search name or slug…"
            >
              <Row gap={2} className="flex-wrap items-end">
                <Stack gap={1}>
                  <Label className="text-xs">Status</Label>
                  <Select
                    value={query.filters.status ?? ANY}
                    onValueChange={(v) => setFilter("status", v)}
                  >
                    <SelectTrigger className="h-9 w-36">
                      <SelectValue placeholder="Any status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any status</SelectItem>
                      {STATUS_OPTIONS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Plan</Label>
                  <Select
                    value={query.filters.planId ?? ANY}
                    onValueChange={(v) => setFilter("planId", v)}
                  >
                    <SelectTrigger className="h-9 w-32">
                      <SelectValue placeholder="Any plan" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any plan</SelectItem>
                      {PLAN_OPTIONS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={query.filters.tenantType ?? ANY}
                    onValueChange={(v) => setFilter("tenantType", v)}
                  >
                    <SelectTrigger className="h-9 w-36">
                      <SelectValue placeholder="Any type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any type</SelectItem>
                      {TENANT_TYPE_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Created from</Label>
                  <Input
                    type="date"
                    className="h-9 w-40"
                    value={query.filters.createdFrom ?? ""}
                    onChange={(e) => setFilter("createdFrom", e.target.value)}
                  />
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Created to</Label>
                  <Input
                    type="date"
                    className="h-9 w-40"
                    value={query.filters.createdTo ?? ""}
                    onChange={(e) => setFilter("createdTo", e.target.value)}
                  />
                </Stack>
              </Row>
            </DataTableToolbar>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(org) => org.id}
              loading={loading}
              emptyMessage="No organizations found."
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
            />
            {meta ? (
              <DataTablePagination
                meta={meta}
                onPageChange={query.setPage}
                onPageSizeChange={query.setPageSize}
              />
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      {/* Confirm dialog: Suspend / Archive (dangerous actions) */}
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmTarget?.action === "suspend"
                ? "Suspend workspace?"
                : "Archive workspace?"}
            </DialogTitle>
            <DialogDescription>
              {confirmTarget?.action === "suspend"
                ? `${confirmTarget?.org.name} will lose dashboard access until reactivated.`
                : `${confirmTarget?.org.name} will be archived (soft delete) and lose access. This is reversible via Reactivate.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={performConfirm}
              >
                {confirmTarget?.action === "suspend" ? "Suspend" : "Archive"}
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit organization</DialogTitle>
            <DialogDescription>
              Update the organization's name, type, and contact details.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={4}>
            <Stack gap={2}>
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="edit-type">Tenant type</Label>
              <Select
                value={editForm.tenantType}
                onValueChange={(v) =>
                  setEditForm((f) => ({ ...f, tenantType: v as OrgSummary["tenantType"] }))
                }
              >
                <SelectTrigger id="edit-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TENANT_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="edit-email">Contact email</Label>
              <Input
                id="edit-email"
                type="email"
                placeholder="Leave blank to clear"
                value={editForm.contactEmail}
                onChange={(e) => setEditForm((f) => ({ ...f, contactEmail: e.target.value }))}
              />
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="edit-phone">Contact phone</Label>
              <Input
                id="edit-phone"
                placeholder="Leave blank to clear"
                value={editForm.contactPhone}
                onChange={(e) => setEditForm((f) => ({ ...f, contactPhone: e.target.value }))}
              />
            </Stack>
          </Stack>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setEditTarget(null)}>
                Cancel
              </Button>
              <Button onClick={submitEdit} disabled={saving || !editForm.name.trim()}>
                Save changes
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change plan dialog */}
      <Dialog open={planTarget !== null} onOpenChange={(open) => !open && setPlanTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change plan</DialogTitle>
            <DialogDescription>
              Applies a manual subscription override for {planTarget?.name}.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={2}>
            <Label htmlFor="plan-select">Plan</Label>
            <Select
              value={planChoice}
              onValueChange={(v) => setPlanChoice(v as (typeof PLAN_OPTIONS)[number])}
            >
              <SelectTrigger id="plan-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Stack>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setPlanTarget(null)}>
                Cancel
              </Button>
              <Button onClick={submitPlan} disabled={saving}>
                Apply
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
