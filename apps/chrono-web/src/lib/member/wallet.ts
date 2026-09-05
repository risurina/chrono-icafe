import { api, unwrap, type Result } from "./client";
import type { PaginationMeta } from "./format";

export type WalletBalance = { balance: string; currency: string; exists: boolean };

export type WalletTransaction = {
  id: string;
  type: "credit" | "debit" | "adjustment";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  reason: string;
  createdAt: string;
};

export type WalletHistoryPage = { items: WalletTransaction[]; meta: PaginationMeta };

export function getMyWalletBalance(): Promise<Result<WalletBalance>> {
  return api.portal.wallet.balance.$get().then((res) => unwrap(res, (json) => json as WalletBalance));
}

export function getMyWalletHistory(query: {
  page?: number;
  pageSize?: number;
  type?: "credit" | "debit" | "adjustment";
} = {}): Promise<Result<WalletHistoryPage>> {
  return api.portal.wallet.history
    .$get({
      query: {
        page: String(query.page ?? 1),
        pageSize: String(query.pageSize ?? 20),
        ...(query.type ? { type: query.type } : {}),
      },
    })
    .then((res) => unwrap(res, (json) => json as WalletHistoryPage));
}

/** The dashboard's "last top-up" — no dedicated endpoint, per Phase E: the
 * newest `type:"credit"` wallet-history row. */
export async function getLastTopUp(): Promise<Result<WalletTransaction | null>> {
  const result = await getMyWalletHistory({ page: 1, pageSize: 1, type: "credit" });
  if (result.data === null) return { data: null, error: result.error };
  return { data: result.data.items[0] ?? null, error: null };
}
