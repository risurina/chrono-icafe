import { api, unwrap, type Result } from "./client";

export type ActivePromo = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  discountType: "percentage" | "fixed_amount";
  discountValue: string;
  minSpend: string | null;
  startsAt: string | null;
  endsAt: string;
  branchName: string | null;
};

export function getActivePromos(): Promise<Result<ActivePromo[]>> {
  return api.portal.promos.$get().then((res) => unwrap(res, (json) => (json as { items: ActivePromo[] }).items));
}
