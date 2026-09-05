import { api, unwrap, type Result } from "./client";

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

export function purchaseCreditProduct(
  productId: string,
): Promise<Result<{ purchase: { id: string }; grant: CreditGrant }>> {
  return api.portal.credits.purchase
    .$post({ json: { productId } })
    .then((res) => unwrap(res, (json) => json as { purchase: { id: string }; grant: CreditGrant }));
}
