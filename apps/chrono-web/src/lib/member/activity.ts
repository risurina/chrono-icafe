import { api, unwrap, type Result } from "./client";
import type { PaginationMeta } from "./format";

export type ActivityEventType = "wallet" | "credit" | "session" | "reservation";

export type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  occurredAt: string;
  title: string;
  description: string;
  amount: string | null;
  status: string | null;
};

export type ActivityFeedPage = { items: ActivityEvent[]; meta: PaginationMeta };

export function getMyActivity(
  query: {
    page?: number;
    pageSize?: number;
    type?: ActivityEventType;
    q?: string;
    sort?: string;
    order?: "asc" | "desc";
  } = {},
): Promise<Result<ActivityFeedPage>> {
  return api.portal.activity
    .$get({
      query: {
        page: String(query.page ?? 1),
        pageSize: String(query.pageSize ?? 20),
        ...(query.type ? { type: query.type } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.sort ? { sort: query.sort, order: query.order ?? "desc" } : {}),
      },
    })
    .then((res) => unwrap(res, (json) => json as ActivityFeedPage));
}
