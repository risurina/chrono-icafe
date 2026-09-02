import { tenantFetch } from "agora/client";
import type { PaginationMeta } from "agora";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface CreditActiveLot {
  id: string;
  remainingQuantity: number;
  stationGroupId: string | null;
  expiresAt: string | null;
}

export interface CreditLedgerEntry {
  id: string;
  type: string;
  quantityDelta: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
}

async function call<T>(path: string, query?: Record<string, string>): Promise<T | null> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await tenantFetch()(`${API_URL}/portal/credits${path}${qs}`, {
    method: "GET",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function getMyCreditBalance(): Promise<{
  activeLots: CreditActiveLot[];
  totalRemainingMinutes: number;
} | null> {
  // Real response shape is { grants, totalRemainingMinutes } — "grants" are
  // the active credit-lot rows, renamed here to the UI's own "activeLots"
  // vocabulary rather than leaking the backend's internal naming.
  const body = await call<{ grants: CreditActiveLot[]; totalRemainingMinutes: number }>(
    "/balance",
  );
  if (!body) return null;
  return { activeLots: body.grants, totalRemainingMinutes: body.totalRemainingMinutes };
}

export function getMyCreditLedger(query: {
  page: number;
  pageSize: number;
}): Promise<{ items: CreditLedgerEntry[]; meta: PaginationMeta } | null> {
  return call<{ items: CreditLedgerEntry[]; meta: PaginationMeta }>("/ledger", {
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
}
