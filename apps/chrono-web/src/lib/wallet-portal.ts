import { tenantFetch } from "agora/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type WalletBalance = {
  balance: string;
  currency: string;
  exists: boolean;
};

export type WalletTransaction = {
  id: string;
  type: "credit" | "debit" | "adjustment";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  reason: string;
  performedByUserId: string | null;
  createdAt: string;
};

export type WalletHistoryMeta = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

async function call<T>(path: string, query?: Record<string, string>): Promise<T | null> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await tenantFetch()(`${API_URL}/portal/wallet${path}${qs}`, {
    method: "GET",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export const getMyWalletBalance = () => call<WalletBalance>("/balance");

export const getMyWalletHistory = (query?: {
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: "asc" | "desc";
}) =>
  call<{ items: WalletTransaction[]; meta: WalletHistoryMeta }>("/history", {
    ...(query?.page ? { page: String(query.page) } : {}),
    ...(query?.pageSize ? { pageSize: String(query.pageSize) } : {}),
    ...(query?.sort ? { sort: query.sort } : {}),
    ...(query?.order ? { order: query.order } : {}),
  });
