"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Stack,
  Row,
  Button,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  type DataTableColumn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Input,
  Label,
  Textarea,
  Badge,
  useListQuery,
  toast,
  Can,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

// Types derived from contracts for frontend use
type LoyaltyTier = "bronze" | "silver" | "gold" | "platinum";

interface LoyaltyAccountRow {
  id: string;
  memberId: string;
  memberName: string | null;
  memberEmail: string | null;
  pointsBalance: number;
  lifetimePoints: number;
  tier: LoyaltyTier;
  createdAt: string;
  updatedAt: string;
}

const TIER_COLORS: Record<LoyaltyTier, "default" | "secondary" | "outline" | "destructive"> = {
  bronze: "outline",
  silver: "secondary",
  gold: "default",
  platinum: "default",
};

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

export default function LoyaltyPage() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  const [accounts, setAccounts] = useState<LoyaltyAccountRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);

  const query = useListQuery();

  const loadAccounts = useCallback(async () => {
    const res = await api.rpc.loyalty.accounts.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
        search: query.q,
        tier: query.filters.tier as LoyaltyTier | undefined,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setAccounts(body.items as LoyaltyAccountRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order, query.q, query.filters.tier]);

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.page, query.pageSize, query.sort, query.order, query.q, query.filters.tier]);

  // Earn / Redeem / Adjust dialog
  const [actionDialog, setActionDialog] = useState<{
    type: "earn" | "redeem" | "adjust";
    account: LoyaltyAccountRow;
  } | null>(null);
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  function openActionDialog(type: "earn" | "redeem" | "adjust", account: LoyaltyAccountRow) {
    setActionDialog({ type, account });
    setPoints("");
    setReason("");
  }

  function closeActionDialog() {
    setActionDialog(null);
    setPoints("");
    setReason("");
  }

  async function submitAction(e: React.FormEvent) {
    e.preventDefault();
    if (!actionDialog) return;
    setSaving(true);
    try {
      const { type, account } = actionDialog;
      const numPoints = parseInt(points, 10);

      if (isNaN(numPoints)) {
        toast.error("Please enter a valid number of points.");
        return;
      }

      let res;
      if (type === "earn") {
        res = await api.rpc.loyalty.accounts[":memberId"].earn.$post({
          param: { memberId: account.memberId },
          json: { points: numPoints, reason },
        });
      } else if (type === "redeem") {
        res = await api.rpc.loyalty.accounts[":memberId"].redeem.$post({
          param: { memberId: account.memberId },
          json: { points: numPoints, reason },
        });
      } else {
        res = await api.rpc.loyalty.accounts[":memberId"].adjust.$post({
          param: { memberId: account.memberId },
          json: { delta: numPoints, reason },
        });
      }

      if (res.ok) {
        toast.success(
          type === "earn"
            ? "Points earned."
            : type === "redeem"
              ? "Points redeemed."
              : "Points adjusted.",
        );
        closeActionDialog();
        loadAccounts();
      } else {
        const message = await extractError(
          res,
          type === "earn"
            ? "Could not earn points."
            : type === "redeem"
              ? "Could not redeem points."
              : "Could not adjust points.",
        );
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  }

  const renderActions = (account: LoyaltyAccountRow) => (
    <Row shrink items="center">
      {/* Earn and Redeem are visible to anyone with loyalty:manage, which is anyone who can see this page */}
      <Button variant="outline" size="sm" onClick={() => openActionDialog("earn", account)}>
        Earn
      </Button>
      <Button variant="outline" size="sm" onClick={() => openActionDialog("redeem", account)}>
        Redeem
      </Button>
      <Can permissions={me?.permissions} resource="loyalty" action="adjust">
        <Button variant="outline" size="sm" onClick={() => openActionDialog("adjust", account)}>
          Adjust
        </Button>
      </Can>
    </Row>
  );

  const columns: DataTableColumn<LoyaltyAccountRow>[] = [
    { key: "memberName", header: "Member", sortable: false },
    { key: "memberEmail", header: "Email", sortable: false },
    {
      key: "tier",
      header: "Tier",
      sortable: false,
      render: (row) => (
        <Badge variant={TIER_COLORS[row.tier]} className="capitalize">
          {row.tier}
        </Badge>
      ),
    },
    {
      key: "pointsBalance",
      header: "Balance",
      sortable: true,
      render: (row) => row.pointsBalance.toLocaleString(),
    },
    {
      key: "lifetimePoints",
      header: "Lifetime",
      sortable: false,
      render: (row) => row.lifetimePoints.toLocaleString(),
    },
    {
      key: "createdAt",
      header: "Joined",
      sortable: true,
      render: (row) => new Date(row.createdAt).toLocaleDateString(),
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Loyalty</h1>
        <p className="text-sm text-muted-foreground">
          Manage member loyalty accounts, points, and tiers.
        </p>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search members…"
      >
        <Select
          value={(query.filters.tier as string) || "all"}
          onValueChange={(val) =>
            query.setFilters({ ...query.filters, tier: val === "all" ? undefined : val })
          }
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="All tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            <SelectItem value="bronze">Bronze</SelectItem>
            <SelectItem value="silver">Silver</SelectItem>
            <SelectItem value="gold">Gold</SelectItem>
            <SelectItem value="platinum">Platinum</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      <DataTable
        columns={columns}
        rows={accounts}
        rowKey={(row) => row.id}
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
        emptyMessage="No loyalty accounts found."
      />

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      {/* Earn / Redeem / Adjust dialog */}
      <Dialog open={!!actionDialog} onOpenChange={(open) => !open && closeActionDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.type === "earn"
                ? `Earn points for ${actionDialog.account.memberName}`
                : actionDialog?.type === "redeem"
                  ? `Redeem points for ${actionDialog.account.memberName}`
                  : `Adjust points for ${actionDialog?.account.memberName}`}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="points">
                {actionDialog?.type === "adjust" ? "Signed points (delta)" : "Points"}
              </Label>
              <Input
                id="points"
                inputMode="numeric"
                type="number"
                placeholder={actionDialog?.type === "adjust" ? "-100" : "100"}
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeActionDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Confirm"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
