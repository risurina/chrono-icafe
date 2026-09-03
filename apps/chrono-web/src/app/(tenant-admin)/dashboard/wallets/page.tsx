"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  Badge,
  Stack,
  Row,
  Can,
  Switch,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type WalletRow = {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  balance: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

type WalletTransaction = {
  id: string;
  type: "credit" | "debit" | "adjustment";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  reason: string;
  performedByUserId: string | null;
  createdAt: string;
};

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

function transactionBadgeVariant(type: WalletTransaction["type"]) {
  if (type === "credit") return "success" as const;
  if (type === "debit") return "warning" as const;
  return "secondary" as const;
}

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export default function WalletsPage() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const query = useListQuery();

  const loadWallets = useCallback(async () => {
    const res = await api.rpc.wallets.$get({
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
      setWallets(body.items as WalletRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    loadWallets();
  }, [loadWallets]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  // Top Up / Debit / Adjust dialog
  const [actionDialog, setActionDialog] = useState<{
    type: "credit" | "debit" | "adjust";
    wallet: WalletRow;
  } | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [cashTendered, setCashTendered] = useState(false);
  const [saving, setSaving] = useState(false);

  function openActionDialog(type: "credit" | "debit" | "adjust", wallet: WalletRow) {
    setActionDialog({ type, wallet });
    setAmount("");
    setReason("");
    setCashTendered(false);
  }

  function closeActionDialog() {
    setActionDialog(null);
    setAmount("");
    setReason("");
    setCashTendered(false);
  }

  async function submitAction(e: React.FormEvent) {
    e.preventDefault();
    if (!actionDialog) return;
    setSaving(true);
    try {
      const { type, wallet } = actionDialog;
      const res =
        type === "credit"
          ? await api.rpc.wallets[":memberId"].credit.$post({
              param: { memberId: wallet.memberId },
              json: { amount, reason: reason || undefined, cashTendered },
            })
          : type === "debit"
            ? await api.rpc.wallets[":memberId"].debit.$post({
                param: { memberId: wallet.memberId },
                json: { amount, reason, cashTendered },
              })
            : await api.rpc.wallets[":memberId"].adjust.$post({
                param: { memberId: wallet.memberId },
                json: { delta: amount, reason },
              });

      if (res.ok) {
        toast.success(
          type === "credit"
            ? "Wallet topped up."
            : type === "debit"
              ? "Wallet debited."
              : "Wallet adjusted.",
        );
        closeActionDialog();
        loadWallets();
        if (historyWallet?.memberId === wallet.memberId) {
          loadHistory(wallet.memberId);
        }
      } else {
        const message = await extractError(
          res,
          type === "credit"
            ? "Could not top up wallet."
            : type === "debit"
              ? "Could not debit wallet."
              : "Could not adjust wallet.",
        );
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  }

  // Transaction history dialog
  const [historyWallet, setHistoryWallet] = useState<WalletRow | null>(null);
  const [history, setHistory] = useState<WalletTransaction[]>([]);
  const [historyMeta, setHistoryMeta] = useState<PaginationMeta | null>(null);
  const historyQuery = useListQuery();

  const loadHistory = useCallback(
    async (memberId: string) => {
      const res = await api.rpc.wallets[":memberId"].transactions.$get({
        param: { memberId },
        query: {
          page: String(historyQuery.page),
          pageSize: String(historyQuery.pageSize),
          sort: historyQuery.sort,
          order: historyQuery.order,
        },
      });
      if (res.ok) {
        const body = await res.json();
        setHistory(body.items as WalletTransaction[]);
        setHistoryMeta(body.meta as PaginationMeta);
      }
    },
    [historyQuery.page, historyQuery.pageSize, historyQuery.sort, historyQuery.order],
  );

  function openHistory(wallet: WalletRow) {
    setHistoryWallet(wallet);
    loadHistory(wallet.memberId);
  }

  useEffect(() => {
    if (historyWallet) {
      loadHistory(historyWallet.memberId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyQuery.page, historyQuery.pageSize, historyQuery.sort, historyQuery.order]);

  const renderActions = (wallet: WalletRow) => (
    <Row shrink items="center">
      <Can permissions={me?.permissions} resource="wallet" action="credit">
        <Button variant="outline" size="sm" onClick={() => openActionDialog("credit", wallet)}>
          Top Up
        </Button>
      </Can>
      <Can permissions={me?.permissions} resource="wallet" action="debit">
        <Button variant="outline" size="sm" onClick={() => openActionDialog("debit", wallet)}>
          Debit
        </Button>
      </Can>
      <Can permissions={me?.permissions} resource="wallet" action="adjust">
        <Button variant="outline" size="sm" onClick={() => openActionDialog("adjust", wallet)}>
          Adjust
        </Button>
      </Can>
      <Button variant="ghost" size="sm" onClick={() => openHistory(wallet)}>
        History
      </Button>
    </Row>
  );

  const columns: DataTableColumn<WalletRow>[] = [
    { key: "memberName", header: "Member", sortable: false },
    { key: "memberEmail", header: "Email", sortable: false },
    {
      key: "balance",
      header: "Balance",
      sortable: true,
      render: (row) => `${row.currency} ${row.balance}`,
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wallets</h1>
        <p className="text-sm text-muted-foreground">
          Top up, debit, or adjust a member&apos;s stored-value balance.
        </p>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search members…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={wallets}
          rowKey={(row) => row.id}
          emptyMessage="No wallets yet."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.memberName}</p>
                <p className="truncate text-xs text-muted-foreground">{row.memberEmail}</p>
                <p className="text-sm">
                  {row.currency} {row.balance}
                </p>
              </div>
              {renderActions(row)}
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={wallets}
          rowKey={(row) => row.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No wallets yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      {/* Top Up / Debit / Adjust dialog */}
      <Dialog open={!!actionDialog} onOpenChange={(open) => !open && closeActionDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.type === "credit"
                ? `Top up ${actionDialog.wallet.memberName}'s wallet`
                : actionDialog?.type === "debit"
                  ? `Debit ${actionDialog.wallet.memberName}'s wallet`
                  : `Adjust ${actionDialog?.wallet.memberName}'s wallet`}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="amount">
                {actionDialog?.type === "adjust" ? "Signed amount (delta)" : "Amount"}
              </Label>
              <Input
                id="amount"
                inputMode="decimal"
                placeholder={actionDialog?.type === "adjust" ? "-5.00" : "0.00"}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason">
                Reason{actionDialog?.type === "credit" ? " (optional)" : ""}
              </Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required={actionDialog?.type !== "credit"}
              />
            </div>
            {actionDialog?.type === "credit" || actionDialog?.type === "debit" ? (
              <Row items="center" justify="between">
                <Label htmlFor="cashTendered">
                  Cash-funded (attribute to my open shift)
                </Label>
                <Switch
                  id="cashTendered"
                  checked={cashTendered}
                  onCheckedChange={setCashTendered}
                />
              </Row>
            ) : null}
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

      {/* Transaction history dialog */}
      <Dialog open={!!historyWallet} onOpenChange={(open) => !open && setHistoryWallet(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{historyWallet?.memberName}&apos;s transaction history</DialogTitle>
          </DialogHeader>
          <Stack gap={4}>
            <DataTable
              columns={[
                {
                  key: "type",
                  header: "Type",
                  render: (row: WalletTransaction) => (
                    <Badge variant={transactionBadgeVariant(row.type)} className="capitalize">
                      {row.type}
                    </Badge>
                  ),
                },
                { key: "amount", header: "Amount" },
                { key: "balanceAfter", header: "Balance after" },
                { key: "reason", header: "Reason" },
                {
                  key: "createdAt",
                  header: "Date",
                  render: (row: WalletTransaction) =>
                    new Date(row.createdAt).toLocaleString(),
                },
              ]}
              rows={history}
              rowKey={(row) => row.id}
              emptyMessage="No transactions yet."
            />
            {historyMeta ? (
              <DataTablePagination
                meta={historyMeta}
                onPageChange={historyQuery.setPage}
                onPageSizeChange={historyQuery.setPageSize}
              />
            ) : null}
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
