import { tenantFetch } from "agora/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type ReservationStatus =
  | "confirmed"
  | "checked_in"
  | "completed"
  | "cancelled"
  | "no_show"
  | "pending"
  | "hold"
  | "cancelled_late"
  | "queue_expired";

export type PortalReservation = {
  id: string;
  stationId: string;
  status: ReservationStatus;
  fromQueue: boolean;
  startAt: string | null;
  endAt: string | null;
  holdExpiresAt: string | null;
  cancelledLateFeeAmount: string | null;
};

export type ReservationPolicy = {
  enabled: boolean;
  reservationAdvanceWindowMinutes: number;
  lateCancellationWindowMinutes: number;
  cancellationFeeEnabled: boolean;
  cancellationFeeAmount: string;
  holdPeriodMinutes: number;
  allowQueueForReservedPc: boolean;
  allowQueueForInUsePc: boolean;
};

export type MemberRestriction = {
  type: "reservation_ban" | "queue_ban" | "queue_failure";
  reason: string;
  expiresAt: string | null;
};

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<{ data: T | null; error: string | null }> {
  const qs = init?.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  const res = await tenantFetch()(`${API_URL}/portal/reservations${path}${qs}`, {
    method: init?.body !== undefined ? (init.method ?? "POST") : (init?.method ?? "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    return { data: null, error: json?.error ?? "Request failed" };
  }
  return { data: json, error: null };
}

export const getMyReservation = () =>
  call<{ reservation: PortalReservation | null; queuePosition: number | null }>("/", { method: "GET" });

export const getReservationPolicy = (stationId: string) =>
  call<{ policy: ReservationPolicy }>("/policy", { method: "GET", query: { stationId } });

export const getMyRestrictions = () =>
  call<{ restrictions: MemberRestriction[] }>("/restrictions", { method: "GET" });

export const reserveStation = (input: { stationId: string; startAt: string; durationMinutes: number }) =>
  call<{ reservation: PortalReservation }>("/", { method: "POST", body: input });

export const joinStationQueue = (input: { stationId: string; durationMinutes: number }) =>
  call<{ reservation: PortalReservation }>("/queue", { method: "POST", body: input });

export const confirmHold = (id: string) => call<{ reservation: PortalReservation }>(`/${id}/confirm`, { method: "POST" });

export const cancelReservation = (id: string, reason?: string) =>
  call<{ reservation: PortalReservation; isLate: boolean; feeAmount: string | null }>(`/${id}/cancel`, {
    method: "POST",
    body: { reason },
  });

export type PublicStation = {
  id: string;
  name: string;
  stationNumber: string;
  stationType: string;
  status: "available" | "occupied" | "maintenance" | "offline";
};

export type PublicBranch = {
  id: string;
  name: string;
  code: string;
  stations: PublicStation[];
};

/** Public, unauthenticated station listing — resolves the tenant from the
 * host, same as the rest of this app's browser client. */
export async function getPublicStations(): Promise<{ branches: PublicBranch[] } | null> {
  const res = await tenantFetch()(`${API_URL}/public/stations`, { method: "GET" });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as { branches: PublicBranch[] } | null;
}
