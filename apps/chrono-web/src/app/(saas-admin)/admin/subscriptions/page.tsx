"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  Can,
  toast,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformSubscriptionRow,
  PlatformPlan,
  PaginationMeta,
  SubscriptionDisplayStatus,
  SubscriptionStatusDTO,
  PlanIdDTO,
} from "agora";
import { usePlatformPermissions } from "../layout";

const FILTER_KEYS = ["status", "planKey", "manualOverride"];

const STATUSES: SubscriptionStatusDTO[] = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "paused",
];

const DISPLAY_STATUS_VARIANT: Record<
  SubscriptionDisplayStatus,
  "success" | "secondary" | "outline" | "warning"
> = {
  active: "success",
  trial: "secondary",
  past_due: "warning",
  paused: "outline",
  canceled: "outline",
  expired: "warning",
};

const DISPLAY_STATUS_LABEL: Record<SubscriptionDisplayStatus, string> = {
  active: "Active",
  trial: "Trial",
  past_due: "Past due",
  paused: "Paused",
  canceled: "Cancelled",
  expired: "Expired",
};

function money(value: string | null, currency: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  const cur = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n);
  } catch {
    return `${cur} ${n.toFixed(2)}`;
  }
}

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

type ActionKind = "change-plan" | "extend-trial" | "cancel" | "pause" | "resume";

const ACTION_TITLE: Record<ActionKind, string> = {
  "change-plan": "Change plan",
  "extend-trial": "Extend trial",
  cancel: "Cancel subscription",
  pause: "Pause subscription",
  resume: "Resume subscription",
};

/**
 * Platform Subscriptions management (spec #6) — a richer cross-tenant view than
 * the `/admin/billing` rollup, with per-tenant actions. All actions route
 * through the manual-override write-path server-side; the UI here is visibility
 * + a permission-gated control surface only. The billing-disabled state is
 * explicit, never inferred from empty data.
 */
export default function SubscriptionsPage() {
  const permissions = usePlatformPermissions();
  const query = useListQuery(FILTER_KEYS);
  const [items, setItems] = useState<PlatformSubscriptionRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  // Assignable plans for the Change-Plan picker: built-in + active only, per
  // #5's assignability contract (custom rows are display-only).
  const [assignablePlans, setAssignablePlans] = useState<PlatformPlan[]>([]);

  const [action, setAction] = useState<{ kind: ActionKind; row: PlatformSubscriptionRow } | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [planKey, setPlanKey] = useState<PlanIdDTO>("pro");
  const [trialEndsAt, setTrialEndsAt] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const q: Record<string, string> = {
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...query.filters,
    };
    if (query.q.trim()) q.q = query.q.trim();
    if (query.sort) {
      q.sort = query.sort;
      q.order = query.order;
    }
    const res = await adminApi["rpc-admin"].subscriptions.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setEnabled(body.enabled);
      if (body.enabled) {
        setItems(body.items as PlatformSubscriptionRow[]);
        setMeta(body.meta as PaginationMeta);
      }
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Load assignable plans once (best-effort; falls back to empty).
  useEffect(() => {
    (async () => {
      const res = await adminApi["rpc-admin"].plans.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setAssignablePlans(
          (body.items as PlatformPlan[]).filter((p) => p.isBuiltIn && p.status === "active"),
        );
      }
    })();
  }, []);

  function openAction(kind: ActionKind, row: PlatformSubscriptionRow) {
    setReason("");
    setTrialEndsAt("");
    setPlanKey((["free", "pro", "enterprise"].includes(row.planKey) ? row.planKey : "pro") as PlanIdDTO);
    setAction({ kind, row });
  }

  async function submitAction() {
    if (!action) return;
    const { kind, row } = action;
    setSaving(true);
    const param = { tenantId: row.tenantId };
    let res: Response;
    if (kind === "change-plan") {
      res = await adminApi["rpc-admin"].subscriptions[":tenantId"]["change-plan"].$post({
        param,
        json: { planKey, reason },
      });
    } else if (kind === "extend-trial") {
      res = await adminApi["rpc-admin"].subscriptions[":tenantId"]["extend-trial"].$post({
        param,
        json: { trialEndsAt: new Date(trialEndsAt).toISOString(), reason },
      });
    } else if (kind === "cancel") {
      res = await adminApi["rpc-admin"].subscriptions[":tenantId"].cancel.$post({
        param,
        json: { reason },
      });
    } else if (kind === "pause") {
      res = await adminApi["rpc-admin"].subscriptions[":tenantId"].pause.$post({
        param,
        json: { reason },
      });
    } else {
      res = await adminApi["rpc-admin"].subscriptions[":tenantId"].resume.$post({
        param,
        json: { reason },
      });
    }
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not apply this change.");
      return;
    }
    setAction(null);
    toast.success(`${ACTION_TITLE[kind]} applied to ${row.tenantName}.`);
    load();
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Subscriptions management is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformSubscriptionRow>[] = [
    {
      key: "tenantName",
      header: "Tenant",
      sortable: true,
      render: (r) => (
        <div className="space-y-1">
          <Link href={`/admin/subscriptions/${r.tenantId}`} className="text-sm font-medium underline">
            {r.tenantName}
          </Link>
          <div className="text-xs text-muted-foreground">{r.tenantSlug}</div>
        </div>
      ),
    },
    {
      key: "planKey",
      header: "Plan",
      sortable: true,
      render: (r) => (
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{r.planLabel ?? r.planKey}</Badge>
          {r.manualOverride ? <Badge variant="outline">Manual</Badge> : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (r) => (
        <Badge variant={DISPLAY_STATUS_VARIANT[r.displayStatus]}>
          {DISPLAY_STATUS_LABEL[r.displayStatus]}
        </Badge>
      ),
    },
    {
      key: "price",
      header: "Price",
      render: (r) => (
        <span className="text-sm" title="Advertised monthly price (not the amount charged)">
          {money(r.price, r.currency)}
        </span>
      ),
    },
    {
      key: "startedAt",
      header: "Started",
      sortable: true,
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.startedAt)}</span>,
    },
    {
      key: "renewalAt",
      header: "Renewal",
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.renewalAt)}</span>,
    },
    {
      key: "trialEndsAt",
      header: "Trial ends",
      render: (r) => <span className="text-sm text-muted-foreground">{date(r.trialEndsAt)}</span>,
    },
    {
      key: "paymentStatus",
      header: "Payment",
      render: (r) => <span className="text-sm text-muted-foreground">{r.paymentStatus}</span>,
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <Can permissions={permissions} resource="organization" action="override_subscription">
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => openAction("change-plan", r)}>
              Change plan
            </Button>
            <Button variant="outline" size="sm" onClick={() => openAction("extend-trial", r)}>
              Extend trial
            </Button>
            {r.status === "paused" ? (
              <Button variant="outline" size="sm" onClick={() => openAction("resume", r)}>
                Resume
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => openAction("pause", r)}>
                Pause
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => openAction("cancel", r)}
            >
              Cancel
            </Button>
          </div>
        </Can>
      ),
    },
  ];

  const dangerous = action?.kind === "cancel" || action?.kind === "pause" || action?.kind === "change-plan";
  const canSubmit =
    reason.trim().length > 0 &&
    (action?.kind !== "extend-trial" || trialEndsAt.trim().length > 0) &&
    !saving;

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant subscription management. Actions here set a manual override
          on the tenant&apos;s mirrored subscription — they never call the payment
          provider. For the aggregate revenue rollup, see{" "}
          <Link href="/admin/billing" className="underline">
            Billing
          </Link>
          .
        </p>
      </div>

      {enabled === false ? (
        <Card>
          <CardHeader>
            <CardTitle>Billing is not configured for this environment.</CardTitle>
            <CardDescription>
              No payment provider secret key is set, so subscription data cannot be
              read and no actions are offered. Configure billing to manage tenant
              subscriptions here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {enabled ? (
        <>
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search tenant name or slug"
            view={query.view}
            onViewChange={query.setView}
          >
            <Select
              value={query.filters.status ?? "all"}
              onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.filters.manualOverride ?? "all"}
              onValueChange={(v) =>
                query.setFilters({ manualOverride: v === "all" ? undefined : v })
              }
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All rows</SelectItem>
                <SelectItem value="true">Manual override</SelectItem>
                <SelectItem value="false">No override</SelectItem>
              </SelectContent>
            </Select>
          </DataTableToolbar>

          <DataTable
            columns={columns}
            rows={items}
            rowKey={(r) => r.tenantId}
            loading={loading}
            emptyMessage="No tenant subscriptions yet."
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
        </>
      ) : null}

      {/* Action dialog (all five actions share it; each requires a reason). */}
      <Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action ? `${ACTION_TITLE[action.kind]} — ${action.row.tenantName}` : ""}
            </DialogTitle>
            <DialogDescription>
              {dangerous
                ? "This changes the tenant's effective plan/status via a manual override. The tenant is notified in their audit trail."
                : "Applies a manual override to this tenant's subscription."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {action?.kind === "change-plan" ? (
              <div className="space-y-2">
                <Label>New plan</Label>
                <Select value={planKey} onValueChange={(v) => setPlanKey(v as PlanIdDTO)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(assignablePlans.length > 0
                      ? assignablePlans.map((p) => ({ key: p.key, label: p.displayName }))
                      : [
                          { key: "free", label: "Free" },
                          { key: "pro", label: "Pro" },
                          { key: "enterprise", label: "Enterprise" },
                        ]
                    ).map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {action?.kind === "extend-trial" ? (
              <div className="space-y-2">
                <Label htmlFor="trial-end">New trial end</Label>
                <Input
                  id="trial-end"
                  type="datetime-local"
                  value={trialEndsAt}
                  onChange={(e) => setTrialEndsAt(e.target.value)}
                />
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="action-reason">Reason</Label>
              <Input
                id="action-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this change being made?"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant={dangerous ? "destructive" : "default"}
              onClick={submitAction}
              disabled={!canSubmit}
            >
              {action ? ACTION_TITLE[action.kind] : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
