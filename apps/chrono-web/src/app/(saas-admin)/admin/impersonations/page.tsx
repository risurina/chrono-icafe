"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  toast,
  Row,
  Stack,
  DataTable,
  DataTableToolbar,
  useListQuery,
  useClientListPage,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { ActivePlatformImpersonation } from "agora";

export default function ActiveImpersonationsPage() {
  const [items, setItems] = useState<ActivePlatformImpersonation[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ActivePlatformImpersonation | null>(
    null,
  );
  const query = useListQuery();
  // Client-side list: this resource's cardinality is bounded by the
  // platform's total admin headcount — the DB's own partial unique index
  // guarantees at most one open grant per admin — the same low-cardinality
  // category as API keys/webhooks per .ai/rules/data-listing.md.
  const { items: pagedItems } = useClientListPage(items, query, (row) => [
    row.actorLabel,
    row.targetLabel,
    row.targetTenantLabel,
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await adminApi["rpc-admin"].impersonation.active.$get();
    setLoading(false);
    if (!res.ok) {
      toast.error("Could not load active impersonation sessions.");
      return;
    }
    const body = await res.json();
    setItems(body.items as ActivePlatformImpersonation[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function forceEnd() {
    if (!confirmTarget) return;
    const target = confirmTarget;
    const res = await adminApi["rpc-admin"].impersonation[":grantId"]["force-end"].$post({
      param: { grantId: target.grantId },
    });
    setConfirmTarget(null);
    if (res.ok) {
      toast.success(`Ended ${target.actorLabel}'s impersonation of ${target.targetLabel}.`);
      setItems((prev) => prev.filter((row) => row.grantId !== target.grantId));
    } else if (res.status === 404 || res.status === 409) {
      toast.error("That impersonation session was already ended.");
      load();
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      toast.error("Could not end this impersonation session.");
    }
  }

  const columns: DataTableColumn<ActivePlatformImpersonation>[] = [
    { key: "actorLabel", header: "Started by" },
    { key: "targetLabel", header: "Impersonating" },
    { key: "targetTenantLabel", header: "Tenant" },
    {
      key: "startedAt",
      header: "Started at",
      render: (row) => (
        <span className="text-muted-foreground">
          {new Date(row.startedAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "expiresAt",
      header: "Expires at",
      render: (row) => (
        <span className="text-muted-foreground">
          {new Date(row.expiresAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmTarget(row)}
        >
          Force end
        </Button>
      ),
    },
  ];

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Impersonations</h1>
        <p className="text-sm text-muted-foreground">
          Every currently open impersonation grant, across all tenants. Force-ending a
          stuck or forgotten session closes the grant and revokes the impersonated
          session server-side.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Ending a session here does not revoke the acting admin's own account — they
            may start a new impersonation afterward.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search by admin or target email…"
          />
          <DataTable
            columns={columns}
            rows={pagedItems}
            rowKey={(row) => row.grantId}
            loading={loading}
            emptyMessage="No active impersonation sessions."
          />
        </CardContent>
      </Card>

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force-end this impersonation session?</DialogTitle>
            <DialogDescription>
              {confirmTarget
                ? `This ends ${confirmTarget.actorLabel}'s impersonation of ` +
                  `${confirmTarget.targetLabel} in ${confirmTarget.targetTenantLabel}. ` +
                  `${confirmTarget.actorLabel} will be signed back into their own admin ` +
                  `session on their next check.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={forceEnd}>
                Force end
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
