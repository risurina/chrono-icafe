"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Skeleton,
  DataTable,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Stack,
} from "agora/ui";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { formatCurrency, formatDateTime, type PaginationMeta } from "@/lib/member/format";
import { getMyWalletBalance, getMyWalletHistory, type WalletBalance, type WalletTransaction } from "@/lib/member/wallet";

const TYPE_VARIANT: Record<WalletTransaction["type"], "default" | "secondary" | "outline"> = {
  credit: "default",
  debit: "secondary",
  adjustment: "outline",
};

export default function MemberWalletPage() {
  const query = useListQuery([]);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, h] = await Promise.all([
      getMyWalletBalance(),
      getMyWalletHistory({
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort ?? "createdAt",
        order: query.order,
      }),
    ]);
    if (b.data) setBalance(b.data);
    if (h.data) {
      setItems(h.data.items);
      setMeta(h.data.meta);
    }
    setLoading(false);
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<WalletTransaction>[] = [
    {
      key: "type",
      header: "Type",
      render: (row) => (
        <Badge variant={TYPE_VARIANT[row.type]} className="capitalize">
          {row.type}
        </Badge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => formatCurrency(row.amount),
    },
    {
      key: "balanceAfter",
      header: "Balance after",
      render: (row) => formatCurrency(row.balanceAfter),
    },
    { key: "reason", header: "Reason", render: (row) => row.reason },
    {
      key: "createdAt",
      header: "Date",
      sortable: true,
      render: (row) => formatDateTime(row.createdAt),
    },
  ];

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="Wallet"
        description="Your wallet balance and transaction history."
        actions={<RefreshButton onRefresh={load} />}
      />

      <Card data-testid="wallet-balance-card">
        <CardHeader>
          <CardTitle>Balance</CardTitle>
          <CardDescription>Available funds for credit purchases.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !balance ? (
            <Skeleton className="h-10 w-40" />
          ) : (
            <p className="text-3xl font-semibold">{formatCurrency(balance?.balance ?? "0.00", balance?.currency)}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transaction history</CardTitle>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(row) => row.id}
              loading={loading}
              emptyMessage="No wallet transactions yet."
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
            />
            {meta ? (
              <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} />
            ) : null}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
