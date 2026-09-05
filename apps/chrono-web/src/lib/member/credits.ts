import { api, unwrap, type Result } from "./client";
import type { PaginationMeta } from "./format";

export type CreditProduct = {
  id: string;
  name: string;
  code: string;
  quantityMinutes: number;
  priceAmount: string;
  validityDays: number | null;
};

export type CreditGrant = {
  id: string;
  productId: string | null;
  remainingQuantity: number;
  status: string;
  expiresAt: string | null;
  priority: number;
};

export type CreditBalance = { grants: CreditGrant[]; totalRemainingMinutes: number };

export function getCreditProducts(): Promise<Result<CreditProduct[]>> {
  return api.portal.credits.products.$get().then((res) =>
    unwrap(res, (json) => (json as { items: CreditProduct[] }).items),
  );
}

export function getMyCreditBalance(): Promise<Result<CreditBalance>> {
  return api.portal.credits.balance.$get().then((res) => unwrap(res, (json) => json as CreditBalance));
}

export type CreditLedgerEntry = {
  id: string;
  grantId: string;
  type: string;
  quantityDelta: number;
  reason: string | null;
  createdAt: string;
};

export type CreditLedgerPage = { items: CreditLedgerEntry[]; meta: PaginationMeta };

export function getMyCreditLedger(query: {
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: "asc" | "desc";
} = {}): Promise<Result<CreditLedgerPage>> {
  return api.portal.credits.ledger
    .$get({
      query: {
        page: String(query.page ?? 1),
        pageSize: String(query.pageSize ?? 20),
        ...(query.sort ? { sort: query.sort, order: query.order ?? "asc" } : {}),
      },
    })
    .then((res) => unwrap(res, (json) => json as CreditLedgerPage));
}

/**
 * `idempotencyKey` (member-wallet-operation-hardening plan): pass the SAME
 * key on a retry of the same user-initiated attempt (a double-click, or the
 * caller retrying after a timed-out-but-uncertain response) to get the
 * original purchase/grant back instead of a second wallet debit. Omit it for
 * a genuinely new purchase attempt. `x-member-action` forces the CORS
 * preflight the server now requires on this route (CSRF defense-in-depth).
 */
export function purchaseCreditProduct(
  productId: string,
  idempotencyKey?: string,
): Promise<Result<{ purchase: { id: string }; grant: CreditGrant }>> {
  return api.portal.credits.purchase
    .$post(
      { json: { productId } },
      {
        headers: {
          "x-member-action": "1",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
      },
    )
    .then((res) => unwrap(res, (json) => json as { purchase: { id: string }; grant: CreditGrant }));
}
