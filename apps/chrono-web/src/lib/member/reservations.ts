import { api, unwrap, type Result } from "./client";

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

export function getMyReservation(): Promise<
  Result<{ reservation: PortalReservation | null; queuePosition: number | null }>
> {
  return api.portal.reservations
    .$get()
    .then((res) =>
      unwrap(res, (json) => json as { reservation: PortalReservation | null; queuePosition: number | null }),
    );
}

export function getReservationPolicy(stationId: string): Promise<Result<{ policy: ReservationPolicy }>> {
  return api.portal.reservations.policy
    .$get({ query: { stationId } })
    .then((res) => unwrap(res, (json) => json as { policy: ReservationPolicy }));
}

export type ReservationAvailabilitySlot = { startAt: string; available: boolean };

export type ReservationAvailability = {
  date: string;
  stationId: string;
  durationMinutes: number;
  granularityMinutes: number;
  slots: ReservationAvailabilitySlot[];
};

/** Discrete bookable start times for a station on a given local calendar
 * date (`YYYY-MM-DD`) at the given duration — backs the reservation slot
 * picker (member-portal-v2 Phase 4). */
export function getReservationAvailability(input: {
  stationId: string;
  date: string;
  durationMinutes: number;
}): Promise<Result<ReservationAvailability>> {
  return api.portal.reservations.availability
    .$get({
      query: {
        stationId: input.stationId,
        date: input.date,
        durationMinutes: String(input.durationMinutes),
      },
    })
    .then((res) => unwrap(res, (json) => json as ReservationAvailability));
}

export function getMyRestrictions(): Promise<Result<{ restrictions: MemberRestriction[] }>> {
  return api.portal.reservations.restrictions
    .$get()
    .then((res) => unwrap(res, (json) => json as { restrictions: MemberRestriction[] }));
}

export function reserveStation(input: {
  stationId: string;
  startAt: string;
  durationMinutes: number;
}): Promise<Result<{ reservation: PortalReservation }>> {
  return api.portal.reservations
    .$post({ json: input })
    .then((res) => unwrap(res, (json) => json as { reservation: PortalReservation }));
}

export function joinStationQueue(input: {
  stationId: string;
  durationMinutes: number;
}): Promise<Result<{ reservation: PortalReservation }>> {
  return api.portal.reservations.queue
    .$post({ json: input })
    .then((res) => unwrap(res, (json) => json as { reservation: PortalReservation }));
}

export function confirmHold(id: string): Promise<Result<{ reservation: PortalReservation }>> {
  return api.portal.reservations[":id"].confirm
    .$post({ param: { id } })
    .then((res) => unwrap(res, (json) => json as { reservation: PortalReservation }));
}

export function cancelReservation(
  id: string,
  reason?: string,
): Promise<Result<{ reservation: PortalReservation; isLate: boolean; feeAmount: string | null }>> {
  return api.portal.reservations[":id"].cancel
    .$post({ param: { id }, json: { reason } })
    .then((res) =>
      unwrap(res, (json) => json as { reservation: PortalReservation; isLate: boolean; feeAmount: string | null }),
    );
}

/** Public, unauthenticated station listing — resolves the tenant from the
 * host via the shared typed client, same as every other `lib/member/*`
 * wrapper. */
export async function getPublicStations(): Promise<{ branches: PublicBranch[] } | null> {
  const res = await api.public.stations.$get();
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as { branches: PublicBranch[] } | null;
}
