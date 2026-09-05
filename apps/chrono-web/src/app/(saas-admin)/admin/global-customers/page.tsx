"use client";

import { useCallback, useEffect, useState } from "react";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Row,
  Stack,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Label,
  Can,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { usePlatformPermissions } from "../layout";
import type {
  PaginationMeta,
  PlatformGlobalCustomerSummary,
  PlatformGlobalCustomerDetail,
} from "agora";

// The global `customer` identity pool — platform-wide, distinct from the
// tenant-scoped tenantMember pool a tenant manages itself at
// {host}/admin/members ("Players").
const SCOPE_COPY = "The platform-wide global customer identity pool.";

type MutatingAction = "suspend" | "reactivate" | "revoke-sessions" | "send-password-reset";

const ANY = "all";

export default function PlatformAdminGlobalCustomersPage() {
  const permissions = usePlatformPermissions();
  const query = useListQuery(["status"]);
  const [items, setItems] = useState<PlatformGlobalCustomerSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<PlatformGlobalCustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{
    customer: PlatformGlobalCustomerSummary;
    action: MutatingAction;
  } | null>(null);

  const setFilter = useCallback(
    (key: string, value: string) => {
      query.setFilters({ [key]: value === ANY ? undefined : value });
    },
    [query],
  );

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setLoading(true);
      const res = await adminApi["rpc-admin"]["global-customers"].$get({
        query: {
          page: String(query.page),
          pageSize: String(query.pageSize),
          ...(query.q ? { q: query.q } : {}),
          ...query.filters,
        },
      });
      if (signal.cancelled) return;
      setLoading(false);
      if (!res.ok) {
        toast.error("Could not load global customers.");
        return;
      }
      const body = await res.json();
      setItems(body.items as PlatformGlobalCustomerSummary[]);
      setMeta(body.meta as PaginationMeta);
    },
    [query.page, query.pageSize, query.q, query.filters],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  async function openDetail(customer: PlatformGlobalCustomerSummary) {
    setDetailLoading(true);
    setDetail(null);
    const res = await adminApi["rpc-admin"]["global-customers"][":customerId"].$get({
      param: { customerId: customer.id },
    });
    setDetailLoading(false);
    if (res.ok) {
      setDetail((await res.json()) as PlatformGlobalCustomerDetail);
    } else {
      toast.error("Could not load this customer's detail.");
    }
  }

  function openConfirm(customer: PlatformGlobalCustomerSummary, action: MutatingAction) {
    setConfirmTarget({ customer, action });
  }

  async function performAction() {
    if (!confirmTarget) return;
    const { customer, action } = confirmTarget;

    let res: Response;
    if (action === "suspend") {
      res = await adminApi["rpc-admin"]["global-customers"][":customerId"].suspend.$post({
        param: { customerId: customer.id },
      });
    } else if (action === "reactivate") {
      res = await adminApi["rpc-admin"]["global-customers"][":customerId"].reactivate.$post({
        param: { customerId: customer.id },
      });
    } else if (action === "revoke-sessions") {
      res = await adminApi["rpc-admin"]["global-customers"][":customerId"][
        "revoke-sessions"
      ].$post({ param: { customerId: customer.id } });
    } else {
      res = await adminApi["rpc-admin"]["global-customers"][":customerId"][
        "send-password-reset"
      ].$post({ param: { customerId: customer.id } });
    }

    setConfirmTarget(null);
    if (res.ok) {
      toast.success(successMessage(customer.email, action));
      load({ cancelled: false });
      if (detail?.id === customer.id) openDetail(customer);
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not complete this action.");
    }
  }

  const columns: DataTableColumn<PlatformGlobalCustomerSummary>[] = [
    {
      key: "email",
      header: "Email",
      render: (c) => (
        <Button variant="link" size="sm" onClick={() => openDetail(c)}>
          {c.email}
        </Button>
      ),
    },
    { key: "name", header: "Name", render: (c) => c.name },
    {
      key: "status",
      header: "Status",
      render: (c) => (
        <Badge variant={c.status === "suspended" ? "warning" : "success"}>
          {c.status === "suspended" ? "Suspended" : "Active"}
        </Badge>
      ),
    },
    {
      key: "memberships",
      header: "Tenants",
      render: (c) => c.membershipCount,
    },
    {
      key: "createdAt",
      header: "Created",
      render: (c) => new Date(c.createdAt).toLocaleDateString(),
    },
  ];

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Global customers</h1>
        <p className="text-sm text-muted-foreground">{SCOPE_COPY}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Global customers</CardTitle>
          <CardDescription>{SCOPE_COPY}</CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search by email or name (min. 2 characters)…"
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
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="suspended">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
              </Row>
            </DataTableToolbar>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(c) => c.id}
              loading={loading}
              emptyMessage={
                query.q && query.q.length > 0
                  ? `No matching global customers found. ${SCOPE_COPY}`
                  : "No global customers found."
              }
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

      <Dialog
        open={detail !== null || detailLoading}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail?.email ?? "Loading…"}</DialogTitle>
            <DialogDescription>Customer detail and actions.</DialogDescription>
          </DialogHeader>
          {detail ? (
            <Stack gap={4}>
              <Row gap={2}>
                <Badge variant={detail.status === "suspended" ? "warning" : "success"}>
                  {detail.status === "suspended" ? "Suspended" : "Active"}
                </Badge>
              </Row>
              <div className="text-sm text-muted-foreground">
                Active sessions: {detail.activeSessionCount}
              </div>
              <Row gap={1} wrap>
                {detail.memberships.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    No tenant memberships.
                  </span>
                ) : (
                  detail.memberships.map((m) => (
                    <Badge key={m.tenantId} variant="secondary">
                      {m.tenantName} ({m.memberStatus}
                      {m.tenantStatus !== "active" ? ` — tenant ${m.tenantStatus}` : ""})
                    </Badge>
                  ))
                )}
              </Row>
              <Row gap={2} wrap>
                <Can permissions={permissions} resource="globalCustomer" action="disable">
                  {detail.status === "suspended" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openConfirm(detail, "reactivate")}
                    >
                      Reactivate
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => openConfirm(detail, "suspend")}
                    >
                      Suspend
                    </Button>
                  )}
                </Can>
                <Can permissions={permissions} resource="globalCustomer" action="resetSessions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openConfirm(detail, "revoke-sessions")}
                  >
                    Revoke all sessions
                  </Button>
                </Can>
                <Can
                  permissions={permissions}
                  resource="globalCustomer"
                  action="sendPasswordReset"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openConfirm(detail, "send-password-reset")}
                  >
                    Send password reset email
                  </Button>
                </Can>
              </Row>
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmTitle(confirmTarget?.action)}</DialogTitle>
            <DialogDescription>{confirmDescription(confirmTarget)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button onClick={performAction}>Confirm</Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

function successMessage(email: string, action: MutatingAction): string {
  switch (action) {
    case "suspend":
      return `${email} was suspended.`;
    case "reactivate":
      return `${email} was reactivated.`;
    case "revoke-sessions":
      return `${email}'s sessions were revoked.`;
    case "send-password-reset":
      return `A password reset email was sent to ${email}.`;
  }
}

function confirmTitle(action: MutatingAction | undefined): string {
  switch (action) {
    case "suspend":
      return "Suspend customer?";
    case "reactivate":
      return "Reactivate customer?";
    case "revoke-sessions":
      return "Revoke all sessions?";
    case "send-password-reset":
      return "Send password reset email?";
    default:
      return "";
  }
}

function confirmDescription(
  confirmTarget: { customer: PlatformGlobalCustomerSummary; action: MutatingAction } | null,
): string {
  if (!confirmTarget) return "";
  const { customer, action } = confirmTarget;
  switch (action) {
    case "suspend":
      return `${customer.email} will be signed out everywhere and blocked from signing in — at the apex portal and every linked tenant — until reactivated.`;
    case "reactivate":
      return `${customer.email} will be able to sign in again.`;
    case "revoke-sessions":
      return `${customer.email} will be signed out everywhere and must sign in again.`;
    case "send-password-reset":
      return `A password reset email will be sent to ${customer.email}.`;
  }
}
