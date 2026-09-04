"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
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
  Badge,
  Stack,
  Row,
  Button,
  buttonVariants,
  CenteredMessage,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Can,
  Input,
  Label,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch,
  ListRow,
  type DataTableColumn,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { useRegisterUploadTarget } from "agora/ui";
import type { UploadTarget } from "@/lib/upload";
import { usePlatformPermissions } from "../../layout";
import { formatMoney, type PlatformTransactionRow } from "agora";
import type {
  PlatformOrgDetail,
  PlatformOrgMemberSummary,
  PaginationMeta,
  PlatformOrgActivityItem,
  PlatformOrgInvoiceStatus,
  PlatformTenantExportRecord,
  PolicyAcceptanceRecord,
  PolicyType,
  UsageTenantDetail,
  UsageQuotaGrant,
  UsageHistoryResponse,
  TenantResourceUsage,
  LimitStatus,
} from "agora";
import { PLAN_IDS, SUBSCRIPTION_STATUSES, type PlanId, type SubscriptionStatus } from "agora/billing";

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

/** A label/value row for the info cards. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row items="center" gap={4} className="justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm text-right">{children}</span>
    </Row>
  );
}

/** Badge color for a usage limit status. */
function usageStatusVariant(
  status: LimitStatus,
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "over") return "destructive";
  if (status === "at" || status === "approaching") return "warning";
  if (status === "ok" || status === "unlimited") return "success";
  return "secondary";
}

/** "used / limit (pct%)", or "not metered" / "unlimited" where those apply. */
function usageResourceLabel(r: TenantResourceUsage): string {
  if (r.status === "unmetered" || r.used === null) return "not metered";
  if (r.limit === -1) return `${r.used} / ∞`;
  if (r.limit === null) return `${r.used}`;
  const pct = r.percent === null ? "" : ` (${r.percent}%)`;
  return `${r.used} / ${r.limit}${pct}`;
}

export default function PlatformAdminOrganizationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const query = useListQuery();
  const permissions = usePlatformPermissions();

  // Global drag/drop + paste (global-upload-drag-drop-paste Phase 3): this
  // org is the one place `/admin/**` has a concrete tenant in view, so it's
  // the only admin page that registers itself as a valid upload target —
  // the write is still gated server-side on `organization:edit`, this is
  // visibility only (`.ai/rules/rbac.md`).
  const uploadTarget = useMemo<UploadTarget>(
    () => ({ kind: "admin-org", orgId: id, feature: "admin-upload", visibility: "private" }),
    [id],
  );
  useRegisterUploadTarget<UploadTarget>(uploadTarget);

  const [org, setOrg] = useState<PlatformOrgDetail | null>(null);
  const [usage, setUsage] = useState<UsageTenantDetail | null>(null);
  const [usageHistory, setUsageHistory] = useState<UsageHistoryResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [members, setMembers] = useState<PlatformOrgMemberSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [impersonateTarget, setImpersonateTarget] =
    useState<PlatformOrgMemberSummary | null>(null);
  const [impersonating, setImpersonating] = useState(false);
  const [activity, setActivity] = useState<PlatformOrgActivityItem[]>([]);
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
  const [ticketRefInput, setTicketRefInput] = useState("");
  const [ticketSaving, setTicketSaving] = useState(false);
  const [invoiceStatus, setInvoiceStatus] = useState<PlatformOrgInvoiceStatus | null>(
    null,
  );
  // Per-tenant payments/attempts timeline (charges, invoices, refunds). Null
  // until loaded; `enabled=false` mirrors the billing-not-configured state.
  const [transactions, setTransactions] = useState<PlatformTransactionRow[] | null>(
    null,
  );
  const [transactionsEnabled, setTransactionsEnabled] = useState(true);

  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overridePlan, setOverridePlan] = useState<PlanId>("pro");
  const [overrideSeats, setOverrideSeats] = useState("1");
  const [overrideStatus, setOverrideStatus] = useState<SubscriptionStatus>("active");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [removeOverrideConfirmOpen, setRemoveOverrideConfirmOpen] = useState(false);
  const [removeOverrideSaving, setRemoveOverrideSaving] = useState(false);
  const [flagPending, setFlagPending] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false);
  const [quotaResource, setQuotaResource] = useState<"seats" | "projects">("seats");
  const [quotaAmount, setQuotaAmount] = useState("1");
  const [quotaExpires, setQuotaExpires] = useState("");
  const [quotaReason, setQuotaReason] = useState("");
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [revokeGrantTarget, setRevokeGrantTarget] = useState<UsageQuotaGrant | null>(null);
  const [revokeGrantSaving, setRevokeGrantSaving] = useState(false);

  // ── Organizations management: Edit + Change Plan ──
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    tenantType: "company" as PlatformOrgDetail["tenantType"],
    contactEmail: "",
    contactPhone: "",
  });
  const [editSaving, setEditSaving] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planChoice, setPlanChoice] = useState<PlanId>("free");
  const [planSaving, setPlanSaving] = useState(false);

  // ── Compliance tooling ──
  const [exportHistory, setExportHistory] = useState<PlatformTenantExportRecord[]>([]);
  const [policyHistory, setPolicyHistory] = useState<PolicyAcceptanceRecord[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportReason, setExportReason] = useState("");
  const [exporting, setExporting] = useState(false);
  const [policyType, setPolicyType] = useState<PolicyType>("terms");
  const [policyVersion, setPolicyVersion] = useState("");
  const [policySaving, setPolicySaving] = useState(false);
  // Both compliance history lists (export requests, policy acceptances) are
  // low-cardinality, per-org data (single digits, server-bounded to 50 rows
  // for exports) — a backend list contract or a second `useListQuery()` URL
  // state (the page's one `query` above already drives the members
  // DataTable's pagination) would be pure overhead, per
  // .ai/rules/data-listing.md's client-side exception. Rendered in full,
  // most-recent-first, no pagination controls.

  const loadOrg = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"].$get({
      param: { id },
    });
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    if (res.ok) setOrg((await res.json()) as PlatformOrgDetail);
  }, [id]);

  function openEdit() {
    if (!org) return;
    setEditForm({
      name: org.name,
      tenantType: org.tenantType,
      contactEmail: org.contactEmail ?? "",
      contactPhone: org.contactPhone ?? "",
    });
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!org) return;
    setEditSaving(true);
    const res = await adminApi["rpc-admin"].organizations[":id"].$patch({
      param: { id },
      json: {
        name: editForm.name.trim(),
        tenantType: editForm.tenantType,
        contactEmail: editForm.contactEmail.trim(),
        contactPhone: editForm.contactPhone.trim(),
      },
    });
    setEditSaving(false);
    if (res.ok) {
      setEditOpen(false);
      await loadOrg();
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not save changes.");
  }

  function openPlan() {
    if (!org) return;
    setPlanChoice((org.subscription?.plan as PlanId) ?? "free");
    setPlanOpen(true);
  }

  async function savePlan() {
    setPlanSaving(true);
    const res = await adminApi["rpc-admin"].organizations[":id"].plan.$patch({
      param: { id },
      json: { planId: planChoice },
    });
    setPlanSaving(false);
    if (res.ok) {
      setPlanOpen(false);
      await loadOrg();
      await loadActivity();
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not change the plan.");
  }

  async function toggleFlag(key: string, enabled: boolean) {
    setFlagError(null);
    setFlagPending(key);
    // Optimistic: reflect the new value while the request is in flight.
    setOrg((current) =>
      current
        ? {
            ...current,
            featureFlags: current.featureFlags.map((f) =>
              f.key === key ? { ...f, enabled } : f,
            ),
          }
        : current,
    );
    const res = await adminApi["rpc-admin"].organizations[":id"]["feature-flags"].$put(
      {
        param: { id },
        json: { key, enabled },
      },
    );
    setFlagPending(null);
    if (res.ok) {
      const body = await res.json();
      setOrg((current) =>
        current ? { ...current, featureFlags: body.features } : current,
      );
      return;
    }
    // Revert on failure and explain.
    await loadOrg();
    if (res.status === 429) {
      setFlagError("Too many actions. Try again later."); toast.error("Too many actions. Try again later.");
      return;
    }
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    setFlagError(errBody?.error ?? "Could not update the feature flag."); toast.error(errBody?.error ?? "Could not update the feature flag.");
  }

  const loadInvoiceStatus = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"]["billing"][
      "invoice-status"
    ].$get({
      param: { id },
    });
    if (res.ok) setInvoiceStatus((await res.json()) as PlatformOrgInvoiceStatus);
  }, [id]);

  const loadTransactions = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"].transactions.$get({
      param: { id },
      query: { pageSize: "10" },
    });
    if (res.ok) {
      const body = await res.json();
      setTransactionsEnabled(body.enabled);
      setTransactions(body.enabled ? (body.items as PlatformTransactionRow[]) : []);
    }
  }, [id]);

  const loadMembers = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"].members.$get({
      param: { id },
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
      setMembers(body.items as PlatformOrgMemberSummary[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [id, query.page, query.pageSize, query.q, query.sort, query.order]);

  const loadActivity = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"].activity.$get({
      param: { id },
    });
    if (res.ok) {
      const body = await res.json();
      setActivity(body.items as PlatformOrgActivityItem[]);
    }
  }, [id]);

  const loadUsage = useCallback(async () => {
    const res = await adminApi["rpc-admin"].usage.organizations[":id"].$get({
      param: { id },
    });
    if (res.ok) setUsage((await res.json()) as UsageTenantDetail);
  }, [id]);

  const loadUsageHistory = useCallback(async () => {
    const res = await adminApi["rpc-admin"].usage.organizations[":id"].history.$get({
      param: { id },
    });
    if (res.ok) setUsageHistory((await res.json()) as UsageHistoryResponse);
  }, [id]);

  function downloadUsageCsv() {
    // The typed client can't stream a CSV body, so hit the export route
    // directly (the shared fetch wrapper still attaches the session +
    // x-platform-admin header). Opening it triggers the browser download.
    const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
    window.open(`${base}/rpc-admin/usage/organizations/${id}/export`, "_blank");
  }

  useEffect(() => {
    loadOrg();
  }, [loadOrg]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  useEffect(() => {
    loadUsageHistory();
  }, [loadUsageHistory]);

  function openQuotaDialog() {
    setQuotaResource("seats");
    setQuotaAmount("1");
    setQuotaExpires("");
    setQuotaReason("");
    setQuotaDialogOpen(true);
  }

  async function addQuota() {
    const amount = Number(quotaAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      toast.error("Amount must be a positive whole number.");
      return;
    }
    if (!quotaReason.trim()) {
      toast.error("A reason is required.");
      return;
    }
    setQuotaSaving(true);
    // A date input yields "YYYY-MM-DD"; send an ISO datetime (end of that day)
    // so the contract's .datetime() accepts it. Empty = permanent (null).
    const expiresAt = quotaExpires
      ? new Date(`${quotaExpires}T23:59:59.000Z`).toISOString()
      : null;
    const res = await adminApi["rpc-admin"].usage.organizations[":id"].quota.$post({
      param: { id },
      json: { resource: quotaResource, amount, expiresAt, reason: quotaReason.trim() },
    });
    setQuotaSaving(false);
    if (res.ok) {
      setQuotaDialogOpen(false);
      loadUsage();
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not add the quota grant.");
    }
  }

  async function revokeQuota() {
    if (!revokeGrantTarget) return;
    setRevokeGrantSaving(true);
    const res = await adminApi["rpc-admin"].usage.organizations[":id"].quota[
      ":grantId"
    ].revoke.$post({
      param: { id, grantId: revokeGrantTarget.id },
    });
    setRevokeGrantSaving(false);
    setRevokeGrantTarget(null);
    if (res.ok) loadUsage();
  }

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    loadInvoiceStatus();
  }, [loadInvoiceStatus]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  const loadExportHistory = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"].compliance.exports.$get({
      param: { id },
    });
    if (res.ok) {
      const body = await res.json();
      setExportHistory(body.items as PlatformTenantExportRecord[]);
    }
  }, [id]);

  const loadPolicyHistory = useCallback(async () => {
    const res = await adminApi["rpc-admin"].organizations[":id"].compliance.policy.$get({
      param: { id },
    });
    if (res.ok) {
      const body = await res.json();
      setPolicyHistory(body.items as PolicyAcceptanceRecord[]);
    }
  }, [id]);

  useEffect(() => {
    loadExportHistory();
  }, [loadExportHistory]);

  useEffect(() => {
    loadPolicyHistory();
  }, [loadPolicyHistory]);

  function openExportDialog() {
    setExportReason("");
    setExportDialogOpen(true);
  }

  // The export bundle is streamed straight to a file download — never held in
  // component state, never logged — so no PII lingers past this handler
  // (.ai/rules/... Risk 7 in the compliance-tooling plan).
  async function requestExport() {
    setExporting(true);
    const res = await adminApi["rpc-admin"].organizations[":id"].compliance.export.$post({
      param: { id },
      json: { reason: exportReason.trim() || undefined },
    });
    setExporting(false);
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not export tenant data.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${org?.slug ?? id}-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportDialogOpen(false);
    await loadExportHistory();
  }

  async function recordPolicyAcceptance() {
    setPolicySaving(true);
    const trimmedVersion = policyVersion.trim();
    const res = await adminApi["rpc-admin"].organizations[":id"].compliance.policy.$post({
      param: { id },
      json: {
        policyType,
        version: trimmedVersion,
        acceptedAt: new Date().toISOString(),
      },
    });
    setPolicySaving(false);
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not record the policy acceptance.");
      return;
    }
    setPolicyVersion("");
    await loadPolicyHistory();
  }

  if (notFound) {
    return <CenteredMessage>Organization not found.</CenteredMessage>;
  }

  if (!org) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  async function startImpersonation() {
    if (!impersonateTarget || !org) return;
    setImpersonating(true);
    const res = await adminApi["rpc-admin"].impersonation.start.$post({
      json: { targetUserId: impersonateTarget.userId },
    });
    if (res.ok) {
      window.location.href = `${window.location.protocol}//${org.slug}.${APP_DOMAIN}/admin`;
      return;
    }
    setImpersonating(false);
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not start impersonation.");
  }

  function openTicketDialog() {
    setTicketRefInput(org?.supportTicketRef ?? "");
    setTicketDialogOpen(true);
  }

  async function saveTicketRef(clear: boolean) {
    setTicketSaving(true);
    const trimmed = ticketRefInput.trim();
    const res = await adminApi["rpc-admin"].organizations[":id"]["support-ticket"].$patch(
      {
        param: { id },
        json: { ticketRef: clear ? null : trimmed },
      },
    );
    setTicketSaving(false);
    if (res.ok) {
      setTicketDialogOpen(false);
      await loadOrg();
      await loadActivity();
      return;
    }
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(errBody?.error ?? "Could not update the ticket reference.");
  }

  function openOverrideDialog() {
    setOverridePlan((org?.subscription?.plan as PlanId) ?? "pro");
    setOverrideSeats(org?.subscription ? String(org.subscription.seats) : "1");
    setOverrideStatus((org?.subscription?.status as SubscriptionStatus) ?? "active");
    setOverrideReason("");
    setOverrideDialogOpen(true);
  }

  async function saveOverride() {
    setOverrideSaving(true);
    const seats = Number(overrideSeats);
    const res = await adminApi["rpc-admin"].organizations[":id"].subscription.override.$patch({
      param: { id },
      json: {
        plan: overridePlan,
        seats,
        status: overrideStatus,
        reason: overrideReason.trim(),
      },
    });
    setOverrideSaving(false);
    if (res.ok) {
      setOverrideDialogOpen(false);
      await loadOrg();
      await loadActivity();
      return;
    }
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not set the override.");
  }

  async function removeOverride() {
    setRemoveOverrideSaving(true);
    const res = await adminApi["rpc-admin"].organizations[":id"].subscription.override.$delete({
      param: { id },
    });
    setRemoveOverrideSaving(false);
    if (res.ok) {
      setRemoveOverrideConfirmOpen(false);
      await loadOrg();
      await loadActivity();
      return;
    }
    if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not remove the override.");
  }

  const columns: DataTableColumn<PlatformOrgMemberSummary>[] = [
    { key: "name", header: "Name", sortable: true },
    { key: "email", header: "Email", sortable: true },
    { key: "role", header: "Role", render: (m) => <span className="capitalize">{m.role}</span> },
    {
      key: "id",
      header: "",
      render: (m) => (
        <Can permissions={permissions} resource="impersonation" action="start">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setImpersonateTarget(m);
            }}
          >
            Impersonate
          </Button>
        </Can>
      ),
    },
  ];

  return (
    <Stack gap={6}>
      <div>
        <Row items="center" gap={2}>
          <Link href="/admin/organizations" className="text-sm text-muted-foreground hover:text-foreground">
            Organizations
          </Link>
          <span className="text-sm text-muted-foreground">/</span>
          <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          <Badge
            variant={
              org.status === "active"
                ? "success"
                : org.status === "suspended"
                  ? "warning"
                  : "secondary"
            }
          >
            {org.status}
          </Badge>
        </Row>
        <p className="text-sm text-muted-foreground">
          {org.slug} · created {new Date(org.createdAt).toLocaleDateString()}
        </p>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="py-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Super Admin view.</span> You
            are managing this tenant platform-wide. A Tenant Admin only sees and edits
            their own organization from their dashboard settings.
          </p>
        </CardContent>
      </Card>

      <Row gap={4} wrap>
        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <Row items="center" gap={2} className="justify-between">
              <div>
                <CardTitle>Organization information</CardTitle>
                <CardDescription>Identity and classification.</CardDescription>
              </div>
              <Can permissions={permissions} resource="organization" action="edit">
                <Button variant="outline" size="sm" onClick={openEdit}>
                  Edit
                </Button>
              </Can>
            </Row>
          </CardHeader>
          <CardContent>
            <Stack gap={2}>
              <Field label="Name">{org.name}</Field>
              <Field label="Slug">{org.slug}</Field>
              <Field label="Tenant type">
                <Badge variant="outline" className="capitalize">
                  {org.tenantType}
                </Badge>
              </Field>
              <Field label="Created">
                {new Date(org.createdAt).toLocaleString()}
              </Field>
              {org.archivedAt ? (
                <Field label="Archived">
                  {new Date(org.archivedAt).toLocaleString()}
                </Field>
              ) : null}
            </Stack>
          </CardContent>
        </Card>

        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>Owner</CardTitle>
            <CardDescription>Primary account for this tenant.</CardDescription>
          </CardHeader>
          <CardContent>
            {org.owner ? (
              <Stack gap={2}>
                <Field label="Name">{org.owner.name}</Field>
                <Field label="Email">{org.owner.email}</Field>
                <Field label="Account">
                  <Link
                    href={`/admin/organizations/members?user=${org.owner.id}`}
                    className="text-sm hover:underline"
                  >
                    View account
                  </Link>
                </Field>
              </Stack>
            ) : (
              <p className="text-sm text-muted-foreground">No owner on record.</p>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <Row items="center" gap={2} className="justify-between">
              <div>
                <CardTitle>Contact information</CardTitle>
                <CardDescription>Platform-maintained contact details.</CardDescription>
              </div>
              <Can permissions={permissions} resource="organization" action="edit">
                <Button variant="outline" size="sm" onClick={openEdit}>
                  Edit
                </Button>
              </Can>
            </Row>
          </CardHeader>
          <CardContent>
            <Stack gap={2}>
              <Field label="Email">{org.contactEmail ?? "—"}</Field>
              <Field label="Phone">{org.contactPhone ?? "—"}</Field>
            </Stack>
          </CardContent>
        </Card>
      </Row>

      <Row gap={4} wrap>
        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>Plan & subscription</CardTitle>
            <CardDescription>Current billing snapshot for this org.</CardDescription>
          </CardHeader>
          <CardContent>
            {org.subscription ? (
              <Stack gap={2}>
                <Row items="center" gap={2}>
                  <span className="text-sm font-medium capitalize">
                    {org.subscription.plan}
                  </span>
                  <Badge variant="secondary" className="capitalize">
                    {org.subscription.status}
                  </Badge>
                </Row>
                <p className="text-sm text-muted-foreground">
                  {org.subscription.seats === -1
                    ? "Unlimited seats"
                    : `${org.subscription.seats} seats`}
                </p>
                {org.subscription.currentPeriodEnd ? (
                  <p className="text-sm text-muted-foreground">
                    Renews{" "}
                    {new Date(org.subscription.currentPeriodEnd).toLocaleDateString()}
                  </p>
                ) : null}
                {org.subscription.stripeDashboardUrl ? (
                  <a
                    href={org.subscription.stripeDashboardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Open in Stripe
                  </a>
                ) : null}
                {invoiceStatus?.enabled === false && invoiceStatus.reason === "error" ? (
                  <p className="text-sm text-muted-foreground">
                    Invoice status unavailable
                  </p>
                ) : null}
                {invoiceStatus?.enabled === true ? (
                  <Row items="center" gap={2}>
                    <Badge variant={invoiceStatus.hasPastDue ? "warning" : "secondary"}>
                      {invoiceStatus.lastInvoiceStatus ?? "no invoices"}
                    </Badge>
                  </Row>
                ) : null}
                {org.subscription.manualOverride ? (
                  <Stack gap={1}>
                    <Badge variant="warning">Manual override active</Badge>
                    {org.subscription.overrideReason ? (
                      <p className="text-sm text-muted-foreground">
                        {org.subscription.overrideReason}
                      </p>
                    ) : null}
                    <p className="text-sm text-muted-foreground">
                      Set by {org.subscription.overrideBy ?? "—"}
                      {org.subscription.overrideAt
                        ? ` on ${new Date(org.subscription.overrideAt).toLocaleString()}`
                        : null}
                    </p>
                  </Stack>
                ) : null}
                <Row gap={2}>
                  <Can
                    permissions={permissions}
                    resource="organization"
                    action="override_subscription"
                  >
                    <Button variant="outline" size="sm" onClick={openPlan}>
                      Change plan
                    </Button>
                  </Can>
                  <Can
                    permissions={permissions}
                    resource="organization"
                    action="override_subscription"
                  >
                    <Button variant="outline" size="sm" onClick={openOverrideDialog}>
                      {org.subscription.manualOverride ? "Change override" : "Override plan"}
                    </Button>
                  </Can>
                  {org.subscription.manualOverride ? (
                    <Can
                      permissions={permissions}
                      resource="organization"
                      action="override_subscription"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRemoveOverrideConfirmOpen(true);
                        }}
                      >
                        Remove override
                      </Button>
                    </Can>
                  ) : null}
                </Row>
              </Stack>
            ) : (
              <Stack gap={2}>
                <p className="text-sm text-muted-foreground">No subscription on file.</p>
                <Can
                  permissions={permissions}
                  resource="organization"
                  action="override_subscription"
                >
                  <Button variant="outline" size="sm" onClick={openOverrideDialog}>
                    Override plan
                  </Button>
                </Can>
              </Stack>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>Feature flags</CardTitle>
            <CardDescription>
              Per-tenant overrides shown as their resolved value (platform kill
              switch / plan / rollout rules apply). Manage a feature globally from
              Feature flags.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {flagError ? <p className="text-sm text-destructive">{flagError}</p> : null}
            <Stack gap={2}>
              {org.featureFlags.map((f) => (
                <ListRow
                  key={f.key}
                  actions={
                    <Can
                      permissions={permissions}
                      resource="featureFlag"
                      action="manage"
                      fallback={
                        <Badge variant={f.enabled ? "success" : "secondary"}>
                          {f.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      }
                    >
                      <Switch
                        checked={f.enabled}
                        disabled={flagPending === f.key}
                        aria-label={`Toggle ${f.label}`}
                        onCheckedChange={(next) => toggleFlag(f.key, next)}
                      />
                    </Can>
                  }
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{f.label}</p>
                    <p className="text-xs text-muted-foreground">{f.description}</p>
                    <Link
                      href={`/admin/feature-flags/${f.key}`}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      Manage globally →
                    </Link>
                  </div>
                </ListRow>
              ))}
            </Stack>
          </CardContent>
        </Card>

        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>Support</CardTitle>
            <CardDescription>External ticket reference for this org.</CardDescription>
          </CardHeader>
          <CardContent>
            <Stack gap={2}>
              <Row items="center" justify="between">
                {org.supportTicketRef ? (
                  <Badge variant="secondary">{org.supportTicketRef}</Badge>
                ) : (
                  <span className="text-sm text-muted-foreground">No ticket linked.</span>
                )}
                <Can permissions={permissions} resource="organization" action="manage">
                  <Button variant="outline" size="sm" onClick={openTicketDialog}>
                    {org.supportTicketRef ? "Edit" : "Link ticket"}
                  </Button>
                </Can>
              </Row>
              {org.supportTicketUpdatedAt ? (
                <p className="text-sm text-muted-foreground">
                  Last updated {new Date(org.supportTicketUpdatedAt).toLocaleString()}
                </p>
              ) : null}
              <Link
                href={`/admin/support?organizationId=${id}`}
                className="text-sm text-primary hover:underline"
              >
                View support tickets
              </Link>
            </Stack>
          </CardContent>
        </Card>

        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>Payments &amp; invoices</CardTitle>
            <CardDescription>
              Recent charges, invoices and refunds mirrored from the payment
              provider — also the payment-attempts view (failed charges appear
              here).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!transactionsEnabled ? (
              <p className="text-sm text-muted-foreground">
                Billing is not configured for this environment.
              </p>
            ) : transactions === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : transactions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
            ) : (
              <Stack gap={2}>
                {invoiceStatus?.enabled && invoiceStatus.lastInvoiceUrl ? (
                  <a
                    href={invoiceStatus.lastInvoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    View latest invoice →
                  </a>
                ) : null}
                {transactions.map((t) => (
                  <ListRow
                    key={t.id}
                    actions={
                      <Badge
                        variant={
                          t.status === "succeeded"
                            ? "success"
                            : t.status === "failed"
                              ? "destructive"
                              : "warning"
                        }
                      >
                        {t.status.replace("_", " ")}
                      </Badge>
                    }
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {formatMoney(t.amount, t.currency)}{" "}
                        <span className="text-xs text-muted-foreground capitalize">
                          · {t.kind}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(t.occurredAt).toLocaleString()}
                        {t.refundedAmount !== "0"
                          ? ` · ${formatMoney(t.refundedAmount, t.currency)} refunded`
                          : ""}
                      </p>
                    </div>
                  </ListRow>
                ))}
                <Link href="/admin/transactions" className="text-xs underline">
                  View all transactions
                </Link>
              </Stack>
            )}
          </CardContent>
        </Card>
      </Row>

      <Card>
        <CardHeader>
          <Row items="center" justify="between">
            <div>
              <CardTitle>Usage &amp; limits</CardTitle>
              <CardDescription>
                Current usage against this tenant&apos;s effective plan limits. Derived
                from real rows — resources with no data source show &ldquo;not metered&rdquo;.
              </CardDescription>
            </div>
            {usage ? (
              <Row gap={2}>
                <Can permissions={permissions} resource="usage" action="manageQuota">
                  <Button variant="outline" size="sm" onClick={openQuotaDialog}>
                    Add quota
                  </Button>
                </Can>
                <Button variant="outline" size="sm" onClick={downloadUsageCsv}>
                  Export CSV
                </Button>
              </Row>
            ) : null}
          </Row>
        </CardHeader>
        <CardContent>
          {usage ? (
            <Stack gap={3}>
              <Row gap={2} items="center" wrap>
                <Badge variant="secondary">Plan: {usage.plan}</Badge>
                <Badge variant="outline">
                  Seat limit: {usage.planLimits.seats === -1 ? "∞" : usage.planLimits.seats}
                </Badge>
                <Badge variant="outline">
                  Project limit:{" "}
                  {usage.planLimits.projects === -1 ? "∞" : usage.planLimits.projects}
                </Badge>
                {usage.seatOverride !== null ? (
                  <Badge variant="warning">Seat override: {usage.seatOverride}</Badge>
                ) : null}
              </Row>
              <Stack gap={2}>
                {usage.resources.map((r) => (
                  <ListRow
                    key={r.resource}
                    actions={
                      <Badge variant={usageStatusVariant(r.status)}>{r.status}</Badge>
                    }
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium capitalize">{r.resource}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {usageResourceLabel(r)}
                      </p>
                    </div>
                  </ListRow>
                ))}
              </Stack>

              {usage.quotaGrants.length > 0 ? (
                <Stack gap={2}>
                  <p className="text-sm font-medium">Quota grants</p>
                  {usage.quotaGrants.map((g) => (
                    <ListRow
                      key={g.id}
                      actions={
                        g.active ? (
                          <Can permissions={permissions} resource="usage" action="manageQuota">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setRevokeGrantTarget(g)}
                            >
                              Revoke
                            </Button>
                          </Can>
                        ) : (
                          <Badge variant="secondary">
                            {g.revokedAt ? "revoked" : "expired"}
                          </Badge>
                        )
                      }
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize">
                          +{g.amount} {g.resource}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {g.expiresAt
                            ? `expires ${new Date(g.expiresAt).toLocaleDateString()}`
                            : "permanent"}
                          {g.reason ? ` · ${g.reason}` : ""}
                        </p>
                      </div>
                    </ListRow>
                  ))}
                </Stack>
              ) : null}

              {usageHistory && usageHistory.items.some((i) => i.points.length > 0) ? (
                <Stack gap={2}>
                  <p className="text-sm font-medium">API requests (recent periods)</p>
                  {usageHistory.items
                    .filter((i) => i.points.length > 0)
                    .flatMap((i) =>
                      i.points.map((p) => (
                        <ListRow key={`${i.resource}-${p.period}`}>
                          <div className="min-w-0">
                            <p className="text-sm font-medium tabular-nums">{p.period}</p>
                            <p className="text-xs text-muted-foreground tabular-nums">
                              {p.value} requests
                            </p>
                          </div>
                        </ListRow>
                      )),
                    )}
                </Stack>
              ) : null}
            </Stack>
          ) : (
            <p className="text-sm text-muted-foreground">Loading usage…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>{org.memberCount} total.</CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search members…"
            />
            <DataTable
              columns={columns}
              rows={members}
              rowKey={(m) => m.id}
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
              emptyMessage="No members in this organization."
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

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Platform-admin actions and impersonation grants for this org.{" "}
            <Link
              href={`/admin/audit?q=${encodeURIComponent(org.name)}`}
              className="underline hover:text-foreground"
            >
              View full history
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length > 0 ? (
            <Stack gap={3}>
              {activity.map((item) => (
                <Row key={`${item.kind}-${item.id}`} items="center" justify="between" gap={2}>
                  <Row items="center" gap={2}>
                    <Badge variant="secondary">
                      {item.kind === "audit" ? item.action : "impersonation.started"}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {item.kind === "audit"
                        ? item.actorLabel ?? "—"
                        : `${item.actorLabel ?? "—"} → ${item.targetLabel ?? "—"}`}
                    </span>
                  </Row>
                  <span className="whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </Row>
              ))}
            </Stack>
          ) : (
            <p className="text-sm text-muted-foreground">No recent activity.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Row justify="between" items="center">
            <div>
              <CardTitle>Compliance</CardTitle>
              <CardDescription>
                Data export requests (DSAR/GDPR) and policy-acceptance history for{" "}
                {org.name}.
              </CardDescription>
            </div>
            <Can permissions={permissions} resource="compliance" action="export">
              <Button onClick={openExportDialog}>Request data export</Button>
            </Can>
          </Row>
        </CardHeader>
        <CardContent className="space-y-6">
          <Stack gap={2}>
            <p className="text-sm font-medium">Export history</p>
            {exportHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No exports requested yet.</p>
            ) : (
              <Stack gap={2}>
                {exportHistory.map((item) => (
                  <ListRow key={item.id}>
                    <Row justify="between" items="center">
                      <Stack gap={0}>
                        <span className="text-sm">
                          {item.reason ?? "(no reason given)"}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {item.requestedByLabel ?? "—"}
                        </span>
                      </Stack>
                      <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(item.requestedAt).toLocaleString()}
                      </span>
                    </Row>
                  </ListRow>
                ))}
              </Stack>
            )}
          </Stack>

          <Stack gap={2}>
            <p className="text-sm font-medium">Policy acceptance</p>
            <Can permissions={permissions} resource="compliance" action="policyManage">
              <Row gap={2} items="end" className="flex-wrap">
                <Stack gap={1}>
                  <Label htmlFor="policy-type">Policy</Label>
                  <Select
                    value={policyType}
                    onValueChange={(v) => setPolicyType(v as PolicyType)}
                  >
                    <SelectTrigger id="policy-type" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="terms">Terms</SelectItem>
                      <SelectItem value="privacy">Privacy</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label htmlFor="policy-version">Version</Label>
                  <Input
                    id="policy-version"
                    placeholder="e.g. 2025-01-01"
                    maxLength={50}
                    value={policyVersion}
                    onChange={(e) => setPolicyVersion(e.target.value)}
                  />
                </Stack>
                <Button
                  onClick={recordPolicyAcceptance}
                  disabled={policySaving || policyVersion.trim().length === 0}
                >
                  {policySaving ? "Recording…" : "Record acceptance"}
                </Button>
              </Row>
            </Can>
            {policyHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No policy acceptances recorded.</p>
            ) : (
              <Stack gap={2}>
                {policyHistory.map((item) => (
                  <ListRow key={item.id}>
                    <Row justify="between" items="center">
                      <Row gap={2} items="center">
                        <Badge variant="secondary">{item.policyType}</Badge>
                        <span className="text-sm">{item.version}</span>
                      </Row>
                      <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(item.acceptedAt).toLocaleString()}
                      </span>
                    </Row>
                  </ListRow>
                ))}
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Row gap={4} wrap>
        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>API & integrations</CardTitle>
            <CardDescription>Tenant-owned API keys and webhook endpoints.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              API keys and webhook endpoints are tenant-owned and managed from the
              tenant&apos;s own dashboard settings. A read-only platform-admin summary
              of them is not yet exposed by a cross-tenant route — deferred to a
              follow-up rather than widening this surface.
            </p>
          </CardContent>
        </Card>
        <Card className="min-w-[280px] flex-1">
          <CardHeader>
            <CardTitle>Security settings</CardTitle>
            <CardDescription>Tenant-level security posture.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No tenant-level org security policy (e.g. enforced 2FA) is backed by a
              real setting today, so nothing fabricated is shown here. Platform-admin
              account hardening lives under Security in the admin nav.
            </p>
          </CardContent>
        </Card>
      </Row>

      <div>
        <Link href="/admin/organizations">
          <Button variant="outline">Back to organizations</Button>
        </Link>
      </div>

      <Dialog open={editOpen} onOpenChange={(open) => !open && setEditOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit organization</DialogTitle>
            <DialogDescription>
              Update {org.name}&apos;s name, type, and contact details.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={4}>
            <Stack gap={2}>
              <Label htmlFor="org-edit-name">Name</Label>
              <Input
                id="org-edit-name"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="org-edit-type">Tenant type</Label>
              <Select
                value={editForm.tenantType}
                onValueChange={(v) =>
                  setEditForm((f) => ({
                    ...f,
                    tenantType: v as PlatformOrgDetail["tenantType"],
                  }))
                }
              >
                <SelectTrigger id="org-edit-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="individual">individual</SelectItem>
                  <SelectItem value="company">company</SelectItem>
                  <SelectItem value="internal">internal</SelectItem>
                </SelectContent>
              </Select>
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="org-edit-email">Contact email</Label>
              <Input
                id="org-edit-email"
                type="email"
                placeholder="Leave blank to clear"
                value={editForm.contactEmail}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, contactEmail: e.target.value }))
                }
              />
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="org-edit-phone">Contact phone</Label>
              <Input
                id="org-edit-phone"
                placeholder="Leave blank to clear"
                value={editForm.contactPhone}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, contactPhone: e.target.value }))
                }
              />
            </Stack>
          </Stack>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button onClick={saveEdit} disabled={editSaving || !editForm.name.trim()}>
                Save changes
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={planOpen} onOpenChange={(open) => !open && setPlanOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change plan</DialogTitle>
            <DialogDescription>
              Applies a manual subscription override for {org.name}.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={4}>
            <Stack gap={2}>
              <Label htmlFor="org-plan-select">Plan</Label>
              <Select
                value={planChoice}
                onValueChange={(v) => setPlanChoice(v as PlanId)}
              >
                <SelectTrigger id="org-plan-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_IDS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Stack>
          </Stack>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setPlanOpen(false)}>
                Cancel
              </Button>
              <Button onClick={savePlan} disabled={planSaving}>
                Apply
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={ticketDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setTicketDialogOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Support ticket reference</DialogTitle>
            <DialogDescription>
              Link an external ticket key (e.g. SUPP-1234) to {org.name}. Free text —
              not validated against any ticketing system.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={2}>
            <Label htmlFor="support-ticket-ref">Ticket reference</Label>
            <Input
              id="support-ticket-ref"
              placeholder="e.g. SUPP-1234"
              maxLength={64}
              value={ticketRefInput}
              onChange={(e) => setTicketRefInput(e.target.value)}
            />
          </Stack>
          <DialogFooter>
            {org.supportTicketRef ? (
              <Button
                variant="outline"
                onClick={() => saveTicketRef(true)}
                disabled={ticketSaving}
              >
                Clear
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => setTicketDialogOpen(false)}
              disabled={ticketSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveTicketRef(false)}
              disabled={ticketSaving || ticketRefInput.trim().length === 0}
            >
              {ticketSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setExportDialogOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request data export</DialogTitle>
            <DialogDescription>
              Build a full data export for {org.name} (GDPR/DSAR). This is a hard admin
              power — logged with your identity, the org, and the reason below.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={2}>
            <Label htmlFor="export-reason">Reason (optional)</Label>
            <Textarea
              id="export-reason"
              placeholder="e.g. DSAR request via support ticket #123"
              maxLength={500}
              value={exportReason}
              onChange={(e) => setExportReason(e.target.value)}
            />
          </Stack>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setExportDialogOpen(false)}
              disabled={exporting}
            >
              Cancel
            </Button>
            <Button onClick={requestExport} disabled={exporting}>
              {exporting ? "Exporting…" : "Export"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={impersonateTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setImpersonateTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Impersonate {impersonateTarget?.name}?</DialogTitle>
            <DialogDescription>
              You will act as {impersonateTarget?.name} ({impersonateTarget?.email}) in{" "}
              {org.name}&apos;s dashboard. This is logged and can be stopped at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImpersonateTarget(null)}
              disabled={impersonating}
            >
              Cancel
            </Button>
            <Button onClick={startImpersonation} disabled={impersonating}>
              {impersonating ? "Starting…" : "Impersonate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={overrideDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setOverrideDialogOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Override plan for {org.name}</DialogTitle>
            <DialogDescription>
              Manually set the plan, seats, and status without touching Stripe.
              While an override is active, Stripe webhooks for this tenant are
              suppressed (not applied) until it&apos;s removed.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={4}>
            <Stack gap={2}>
              <Label htmlFor="override-plan">Plan</Label>
              <Select
                value={overridePlan}
                onValueChange={(v) => setOverridePlan(v as PlanId)}
              >
                <SelectTrigger id="override-plan">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_IDS.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="override-seats">Seats (-1 for unlimited)</Label>
              <Input
                id="override-seats"
                type="number"
                value={overrideSeats}
                onChange={(e) => setOverrideSeats(e.target.value)}
              />
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="override-status">Status</Label>
              <Select
                value={overrideStatus}
                onValueChange={(v) => setOverrideStatus(v as SubscriptionStatus)}
              >
                <SelectTrigger id="override-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUBSCRIPTION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="override-reason">Reason (required)</Label>
              <Textarea
                id="override-reason"
                placeholder="e.g. Comped for enterprise pilot per SUPP-1234"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </Stack>
          </Stack>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOverrideDialogOpen(false)}
              disabled={overrideSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={saveOverride}
              disabled={overrideSaving || overrideReason.trim().length === 0}
            >
              {overrideSaving ? "Saving…" : "Confirm override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeOverrideConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveOverrideConfirmOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove override?</DialogTitle>
            <DialogDescription>
              Control reverts to Stripe sync for {org.name}. If a Stripe event
              arrived while overridden, it will be applied now.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveOverrideConfirmOpen(false)}
              disabled={removeOverrideSaving}
            >
              Cancel
            </Button>
            <Button onClick={removeOverride} disabled={removeOverrideSaving}>
              {removeOverrideSaving ? "Removing…" : "Remove override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={quotaDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setQuotaDialogOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add quota grant</DialogTitle>
            <DialogDescription>
              Grant {org.name} extra units of a resource, on top of its plan limit.
              Leave the expiry empty for a permanent grant.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={3}>
            <div className="space-y-2">
              <Label>Resource</Label>
              <Select
                value={quotaResource}
                onValueChange={(v) => setQuotaResource(v as "seats" | "projects")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="seats">seats</SelectItem>
                  <SelectItem value="projects">projects</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="quota-amount">Amount</Label>
              <Input
                id="quota-amount"
                type="number"
                min="1"
                value={quotaAmount}
                onChange={(e) => setQuotaAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quota-expires">Expires (optional)</Label>
              <Input
                id="quota-expires"
                type="date"
                value={quotaExpires}
                onChange={(e) => setQuotaExpires(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quota-reason">Reason</Label>
              <Textarea
                id="quota-reason"
                value={quotaReason}
                onChange={(e) => setQuotaReason(e.target.value)}
                placeholder="Why is this grant being added?"
              />
            </div>
          </Stack>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQuotaDialogOpen(false)}
              disabled={quotaSaving}
            >
              Cancel
            </Button>
            <Button onClick={addQuota} disabled={quotaSaving}>
              {quotaSaving ? "Adding…" : "Add grant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeGrantTarget !== null}
        onOpenChange={(open) => !open && setRevokeGrantTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke quota grant?</DialogTitle>
            <DialogDescription>
              {revokeGrantTarget
                ? `Revoking +${revokeGrantTarget.amount} ${revokeGrantTarget.resource} for ${org.name} will drop its effective limit back down.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeGrantTarget(null)}
              disabled={revokeGrantSaving}
            >
              Cancel
            </Button>
            <Button onClick={revokeQuota} disabled={revokeGrantSaving}>
              {revokeGrantSaving ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
