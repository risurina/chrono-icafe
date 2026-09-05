import { api, unwrap, type Result } from "./client";
import type { PaginationMeta } from "./format";

export type PortalSessionSummary = {
  id: string;
  stationId: string;
  stationName: string;
  status: "active" | "paused" | "ended";
  startedAt: string;
  scheduledEndAt: string | null;
  endedAt: string | null;
  actualBillableSeconds: number | null;
  amountCharged: string | null;
  currency: string;
};

export type TodayUsage = {
  billableSeconds: number;
  sessionCount: number;
  amountCharged: string;
  currency: string;
  timezone: string;
};

export type SessionSummary = { active: PortalSessionSummary | null; today: TodayUsage };

export function getMyActiveSession(): Promise<Result<PortalSessionSummary | null>> {
  return api.portal.sessions.active.$get().then((res) =>
    unwrap(res, (json) => (json as { session: PortalSessionSummary | null }).session),
  );
}

export function getMySessionSummary(): Promise<Result<SessionSummary>> {
  return api.portal.sessions.summary.$get().then((res) => unwrap(res, (json) => json as SessionSummary));
}

export function getMySessions(query: {
  page?: number;
  pageSize?: number;
} = {}): Promise<Result<{ items: PortalSessionSummary[]; meta: PaginationMeta }>> {
  return api.portal.sessions
    .$get({ query: { page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 20) } })
    .then((res) => unwrap(res, (json) => json as { items: PortalSessionSummary[]; meta: PaginationMeta }));
}

export type SessionDetail = PortalSessionSummary & {
  rateSnapshot: unknown;
  creditMinutesConsumed: number;
};

export async function getMySession(id: string): Promise<Result<SessionDetail | null>> {
  const res = await api.portal.sessions[":id"].$get({ param: { id } });
  if (res.status === 404) {
    const ok: Result<SessionDetail | null> = { data: null, error: null };
    return ok;
  }
  return unwrap(res, (json) => (json as { session: SessionDetail }).session);
}
