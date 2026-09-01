"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
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
  Textarea,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  Can,
  type DataTableColumn,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformPlan, PlanStatusDTO, PlanTypeDTO, PaginationMeta } from "agora";
import { usePlatformPermissions } from "../layout";

const FILTER_KEYS = ["planType", "status"];

const PLAN_TYPES: PlanTypeDTO[] = [
  "free",
  "trial",
  "basic",
  "professional",
  "business",
  "enterprise",
  "custom",
];
const PLAN_STATUSES: PlanStatusDTO[] = ["draft", "active", "archived"];

const STATUS_VARIANT: Record<PlanStatusDTO, "success" | "secondary" | "outline"> = {
  active: "success",
  draft: "secondary",
  archived: "outline",
};

function money(value: string, currency: string): string {
  const n = Number(value);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(n);
  } catch {
    return `${currency.toUpperCase()} ${n.toFixed(2)}`;
  }
}

function limit(value: number): string {
  return value < 0 ? "Unlimited" : String(value);
}

/** One editable price row (create + edit share it) — mirrors `PlanPriceInput`. */
type PriceRow = { currency: string; monthlyPrice: string; annualPrice: string };

/** Editable form state (create + edit share it). Numeric fields are strings for inputs. */
type PlanForm = {
  key: string;
  displayName: string;
  description: string;
  planType: PlanTypeDTO;
  /** One row per priced currency. Always at least one — the first row's values
   * also populate the legacy top-level monthlyPrice/annualPrice/currency fields
   * on submit, so the existing single-currency dual-write path keeps working. */
  prices: PriceRow[];
  trialDays: string;
  maxUsers: string;
  maxStorageMb: string;
  apiRateLimitPerMin: string;
  /** Empty string = use the code-default retention for this plan key. */
  auditRetentionDays: string;
  featureAccess: string; // comma-separated
  status: PlanStatusDTO;
};

const EMPTY_PRICE_ROW: PriceRow = { currency: "usd", monthlyPrice: "0", annualPrice: "0" };

const EMPTY_FORM: PlanForm = {
  key: "",
  displayName: "",
  description: "",
  planType: "custom",
  prices: [{ ...EMPTY_PRICE_ROW }],
  trialDays: "0",
  maxUsers: "0",
  maxStorageMb: "0",
  apiRateLimitPerMin: "0",
  auditRetentionDays: "",
  featureAccess: "",
  status: "active",
};

function toForm(p: PlatformPlan): PlanForm {
  return {
    key: p.key,
    displayName: p.displayName,
    description: p.description ?? "",
    planType: p.planType,
    // Fall back to the legacy scalar fields for a plan with no plan_price rows
    // yet (predates this phase, or hasn't been re-saved since).
    prices:
      p.prices && p.prices.length > 0
        ? p.prices.map((pr) => ({
            currency: pr.currency,
            monthlyPrice: pr.monthlyPrice,
            annualPrice: pr.annualPrice,
          }))
        : [{ currency: p.currency, monthlyPrice: p.monthlyPrice, annualPrice: p.annualPrice }],
    trialDays: String(p.trialDays),
    maxUsers: String(p.maxUsers),
    maxStorageMb: String(p.maxStorageMb),
    apiRateLimitPerMin: String(p.apiRateLimitPerMin),
    auditRetentionDays: p.auditRetentionDays === null ? "" : String(p.auditRetentionDays),
    featureAccess: p.featureAccess.join(", "),
    status: p.status,
  };
}

/** The editable payload shared by create + patch (key/status handled per-mode). */
function formPayload(f: PlanForm) {
  const rows = f.prices.map((pr) => ({
    currency: pr.currency.trim().toLowerCase() || "usd",
    monthlyPrice: pr.monthlyPrice.trim() || "0",
    annualPrice: pr.annualPrice.trim() || "0",
  }));
  const first = rows[0] ?? EMPTY_PRICE_ROW;
  return {
    displayName: f.displayName.trim(),
    description: f.description.trim() ? f.description.trim() : null,
    planType: f.planType,
    // Legacy top-level fields, populated from the first price row — keeps the
    // existing single-currency dual-write path (and any code still reading the
    // scalar plan.monthlyPrice/annualPrice/currency columns) working unchanged.
    monthlyPrice: first.monthlyPrice,
    annualPrice: first.annualPrice,
    currency: first.currency,
    // Full price-row list — the new multi-currency write path (full-replace on
    // PATCH; additive on POST).
    prices: rows,
    trialDays: Number(f.trialDays) || 0,
    maxUsers: Number(f.maxUsers),
    maxStorageMb: Number(f.maxStorageMb),
    apiRateLimitPerMin: Number(f.apiRateLimitPerMin),
    auditRetentionDays: f.auditRetentionDays.trim() ? Number(f.auditRetentionDays) : null,
    featureAccess: f.featureAccess
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    status: f.status,
  };
}

/**
 * Platform-global subscription-plan catalog. The advertised limits and prices
 * are display/commercial metadata that OVERLAY the code-defined enforced
 * entitlements — never the enforced caps (see the plan's Context). Server-
 * paginated via `useListQuery(FILTER_KEYS)`.
 */
export default function PlansPage() {
  const permissions = usePlatformPermissions();
  const [items, setItems] = useState<PlatformPlan[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const query = useListQuery(FILTER_KEYS);

  // Dialog state.
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; plan?: PlatformPlan } | null>(
    null,
  );
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM);
  const [duplicating, setDuplicating] = useState<PlatformPlan | null>(null);
  const [dupForm, setDupForm] = useState({ newKey: "", displayName: "" });
  const [archiving, setArchiving] = useState<PlatformPlan | null>(null);
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
    const res = await adminApi["rpc-admin"].plans.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as PlatformPlan[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditing({ mode: "create" });
  }

  function openEdit(plan: PlatformPlan) {
    setForm(toForm(plan));
    setEditing({ mode: "edit", plan });
  }

  async function submitForm() {
    if (!editing) return;
    setSaving(true);
    const payload = formPayload(form);
    const res =
      editing.mode === "create"
        ? await adminApi["rpc-admin"].plans.$post({
            json: { key: form.key.trim(), ...payload },
          })
        : await adminApi["rpc-admin"].plans[":key"].$patch({
            param: { key: editing.plan!.key },
            // Built-in plan types are code-anchored — never send a changed
            // planType for one (the field is disabled in the UI too).
            json: editing.plan!.isBuiltIn
              ? { ...payload, planType: editing.plan!.planType }
              : payload,
          });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not save this plan.");
      return;
    }
    setEditing(null);
    toast.success(editing.mode === "create" ? "Plan created." : "Plan updated.");
    load();
  }

  async function submitDuplicate() {
    if (!duplicating) return;
    setSaving(true);
    const res = await adminApi["rpc-admin"].plans[":key"].duplicate.$post({
      param: { key: duplicating.key },
      json: { newKey: dupForm.newKey.trim(), displayName: dupForm.displayName.trim() },
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not duplicate this plan.");
      return;
    }
    setDuplicating(null);
    toast.success("Plan duplicated as a draft.");
    load();
  }

  async function transition(plan: PlatformPlan, action: "activate" | "deactivate" | "archive") {
    const res = await adminApi["rpc-admin"].plans[":key"][action].$post({
      param: { key: plan.key },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? `Could not ${action} this plan.`);
      return;
    }
    setArchiving(null);
    toast.success(
      action === "activate"
        ? "Plan activated."
        : action === "deactivate"
          ? "Plan deactivated."
          : "Plan archived.",
    );
    load();
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              The plan catalog is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformPlan>[] = [
    {
      key: "displayName",
      header: "Plan",
      sortable: true,
      render: (p) => (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{p.displayName}</span>
            {p.isBuiltIn ? <Badge variant="outline">built-in</Badge> : null}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{p.planType}</Badge>
            <span className="text-xs text-muted-foreground">{p.key}</span>
          </div>
        </div>
      ),
    },
    {
      key: "monthlyPrice",
      header: "Monthly",
      sortable: true,
      render: (p) => <span className="text-sm">{money(p.monthlyPrice, p.currency)}</span>,
    },
    {
      key: "annual",
      header: "Annual",
      render: (p) => <span className="text-sm">{money(p.annualPrice, p.currency)}</span>,
    },
    {
      key: "trial",
      header: "Trial",
      render: (p) => (
        <span className="text-sm text-muted-foreground">
          {p.trialDays > 0 ? `${p.trialDays}d` : "—"}
        </span>
      ),
    },
    {
      key: "auditRetention",
      header: "Audit retention",
      render: (p) => (
        <span className="text-sm text-muted-foreground">
          {p.auditRetentionDays !== null ? `${p.auditRetentionDays}d (override)` : "—"}
        </span>
      ),
    },
    {
      key: "maxUsers",
      header: "Max users",
      render: (p) => <span className="text-sm text-muted-foreground">{limit(p.maxUsers)}</span>,
    },
    {
      key: "subscriberCount",
      header: "Subscribers",
      sortable: true,
      render: (p) => <span className="text-sm">{p.subscriberCount}</span>,
    },
    {
      key: "activeSubs",
      header: "Active subs",
      render: (p) => <span className="text-sm">{p.activeSubscriptionCount}</span>,
    },
    {
      key: "estMrr",
      header: "Est. MRR",
      render: (p) => <span className="text-sm">{money(p.estMonthlyRevenue, p.currency)}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (p) => <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>,
    },
    {
      key: "actions",
      header: "",
      render: (p) => (
        <Can permissions={permissions} resource="plan" action="manage">
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDupForm({ newKey: "", displayName: `${p.displayName} copy` });
                setDuplicating(p);
              }}
            >
              Duplicate
            </Button>
            {p.status === "active" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={p.activeSubscriptionCount > 0}
                title={
                  p.activeSubscriptionCount > 0
                    ? "Tenants are still subscribed to this plan."
                    : undefined
                }
                onClick={() => transition(p, "deactivate")}
              >
                Deactivate
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => transition(p, "activate")}>
                Activate
              </Button>
            )}
            {!p.isBuiltIn && p.status !== "archived" ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={p.subscriberCount > 0}
                title={
                  p.subscriberCount > 0
                    ? "Tenants are still subscribed to this plan."
                    : undefined
                }
                onClick={() => {
                  setArchiving(p);
                }}
              >
                Archive
              </Button>
            ) : null}
          </div>
        </Can>
      ),
    },
  ];

  return (
    <Stack>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plans</h1>
          <p className="text-sm text-muted-foreground">
            The platform subscription-plan catalog. Prices and limits here are advertised
            values — the enforced entitlements for the built-in plans stay code-defined.
          </p>
        </div>
        <Can permissions={permissions} resource="plan" action="manage">
          <Button onClick={openCreate}>Create plan</Button>
        </Can>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search name or key"
        view={query.view}
        onViewChange={query.setView}
      >
        <Select
          value={query.filters.planType ?? "all"}
          onValueChange={(v) => query.setFilters({ planType: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {PLAN_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.filters.status ?? "all"}
          onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {PLAN_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </DataTableToolbar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(p) => p.id}
        loading={loading}
        emptyMessage="No plans yet."
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

      {/* Create / edit form dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === "create" ? "Create plan" : `Edit ${editing?.plan?.displayName}`}
            </DialogTitle>
            <DialogDescription>
              {editing?.plan?.isBuiltIn
                ? "Built-in plan. Its key and type are code-anchored; the values below are advertised, not enforced."
                : "Advertised commercial and presentation metadata for this plan."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {editing?.mode === "create" ? (
              <div className="space-y-2">
                <Label htmlFor="plan-key">Key</Label>
                <Input
                  id="plan-key"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  placeholder="startup"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="plan-name">Display name</Label>
              <Input
                id="plan-name"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-desc">Description</Label>
              <Textarea
                id="plan-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Plan type</Label>
                <Select
                  value={form.planType}
                  onValueChange={(v) => setForm({ ...form, planType: v as PlanTypeDTO })}
                >
                  <SelectTrigger disabled={editing?.plan?.isBuiltIn}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLAN_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: v as PlanStatusDTO })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLAN_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Prices</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm({
                      ...form,
                      prices: [...form.prices, { ...EMPTY_PRICE_ROW, currency: "" }],
                    })
                  }
                >
                  Add currency
                </Button>
              </div>
              <Stack className="gap-3">
                {form.prices.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`plan-price-currency-${i}`}>Currency</Label>
                      <Input
                        id={`plan-price-currency-${i}`}
                        value={row.currency}
                        onChange={(e) => {
                          const prices = [...form.prices];
                          prices[i] = { ...row, currency: e.target.value };
                          setForm({ ...form, prices });
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`plan-price-monthly-${i}`}>Monthly price</Label>
                      <Input
                        id={`plan-price-monthly-${i}`}
                        value={row.monthlyPrice}
                        onChange={(e) => {
                          const prices = [...form.prices];
                          prices[i] = { ...row, monthlyPrice: e.target.value };
                          setForm({ ...form, prices });
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`plan-price-annual-${i}`}>Annual price</Label>
                      <Input
                        id={`plan-price-annual-${i}`}
                        value={row.annualPrice}
                        onChange={(e) => {
                          const prices = [...form.prices];
                          prices[i] = { ...row, annualPrice: e.target.value };
                          setForm({ ...form, prices });
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 border-0 text-muted-foreground hover:text-destructive focus-visible:ring-0 focus-visible:ring-offset-0"
                      disabled={form.prices.length <= 1}
                      onClick={() =>
                        setForm({
                          ...form,
                          prices: form.prices.filter((_, idx) => idx !== i),
                        })
                      }
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </Stack>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="plan-trial">Trial days</Label>
                <Input
                  id="plan-trial"
                  value={form.trialDays}
                  onChange={(e) => setForm({ ...form, trialDays: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan-maxusers">Max users (-1 = unlimited)</Label>
                <Input
                  id="plan-maxusers"
                  value={form.maxUsers}
                  onChange={(e) => setForm({ ...form, maxUsers: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan-storage">Max storage MB (-1 = unlimited)</Label>
                <Input
                  id="plan-storage"
                  value={form.maxStorageMb}
                  onChange={(e) => setForm({ ...form, maxStorageMb: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan-api">API/min (-1 = unlimited)</Label>
                <Input
                  id="plan-api"
                  value={form.apiRateLimitPerMin}
                  onChange={(e) => setForm({ ...form, apiRateLimitPerMin: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan-audit-retention">
                  Audit log retention, days (blank = code default)
                </Label>
                <Input
                  id="plan-audit-retention"
                  placeholder="Default"
                  value={form.auditRetentionDays}
                  onChange={(e) =>
                    setForm({ ...form, auditRetentionDays: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-features">Feature access (comma-separated)</Label>
              <Input
                id="plan-features"
                value={form.featureAccess}
                onChange={(e) => setForm({ ...form, featureAccess: e.target.value })}
                placeholder="custom_domains, priority_support"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitForm} disabled={saving}>
              {editing?.mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicate dialog */}
      <Dialog open={duplicating !== null} onOpenChange={(open) => !open && setDuplicating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate {duplicating?.displayName}</DialogTitle>
            <DialogDescription>
              Creates a new custom plan in draft status with a copy of this plan&apos;s values.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dup-key">New key</Label>
              <Input
                id="dup-key"
                value={dupForm.newKey}
                onChange={(e) => setDupForm({ ...dupForm, newKey: e.target.value })}
                placeholder="startup-2"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dup-name">Display name</Label>
              <Input
                id="dup-name"
                value={dupForm.displayName}
                onChange={(e) => setDupForm({ ...dupForm, displayName: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDuplicating(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitDuplicate} disabled={saving}>
              Duplicate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive confirm dialog */}
      <Dialog open={archiving !== null} onOpenChange={(open) => !open && setArchiving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {archiving?.displayName}?</DialogTitle>
            <DialogDescription>
              {archiving && archiving.subscriberCount > 0
                ? `${archiving.subscriberCount} tenant(s) still subscribe to this plan — archiving is blocked until they move off it.`
                : "Archiving hides the plan from the catalog. You can reactivate it later."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!archiving || archiving.subscriberCount > 0}
              onClick={() => archiving && transition(archiving, "archive")}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
