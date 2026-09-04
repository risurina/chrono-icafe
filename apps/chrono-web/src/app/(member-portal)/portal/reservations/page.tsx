"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Label,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "agora/ui";
import {
  getMyReservation,
  getReservationPolicy,
  getMyRestrictions,
  reserveStation,
  joinStationQueue,
  confirmHold,
  cancelReservation,
  getPublicStations,
  type PortalReservation,
  type ReservationPolicy,
  type MemberRestriction,
  type PublicBranch,
} from "@/lib/reservations-portal";

const DURATION_OPTIONS = [60, 120, 180, 240, 300, 360];

function formatUnbanDate(iso: string | null): string {
  if (!iso) return "soon";
  return new Date(iso).toLocaleString();
}

function useCountdown(targetIso: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!targetIso) {
      setLabel(null);
      return;
    }
    const target = new Date(targetIso).getTime();
    const tick = () => {
      const remainingMs = target - Date.now();
      if (remainingMs <= 0) {
        setLabel("00:00");
        return;
      }
      const totalSeconds = Math.floor(remainingMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      setLabel(`${minutes}:${seconds.toString().padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return label;
}

export default function PortalReservationsPage() {
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<PublicBranch[]>([]);
  const [active, setActive] = useState<PortalReservation | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [restrictions, setRestrictions] = useState<MemberRestriction[]>([]);

  const [pickedStation, setPickedStation] = useState<{ id: string; name: string; status: string } | null>(
    null,
  );
  const [policy, setPolicy] = useState<ReservationPolicy | null>(null);
  const [duration, setDuration] = useState(60);
  const [startAt, setStartAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<PortalReservation | null>(null);
  const [cancelPreview, setCancelPreview] = useState<{ isLate: boolean; feeAmount: string | null } | null>(
    null,
  );
  const [cancelling, setCancelling] = useState(false);

  const holdCountdown = useCountdown(active?.status === "hold" ? active.holdExpiresAt : null);

  const load = useCallback(async () => {
    const [stationsRes, mine, myRestrictions] = await Promise.all([
      getPublicStations(),
      getMyReservation(),
      getMyRestrictions(),
    ]);
    if (stationsRes) setBranches(stationsRes.branches);
    if (mine.data) {
      setActive(mine.data.reservation);
      setQueuePosition(mine.data.queuePosition);
    }
    if (myRestrictions.data) setRestrictions(myRestrictions.data.restrictions);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const reservationBan = restrictions.find((r) => r.type === "reservation_ban");
  const queueBan = restrictions.find((r) => r.type === "queue_ban");

  async function openReserveDialog(station: { id: string; name: string; status: string }) {
    setPickedStation(station);
    const res = await getReservationPolicy(station.id);
    if (res.data) setPolicy(res.data.policy);
    const now = new Date(Date.now() + 5 * 60_000);
    setStartAt(now.toISOString().slice(0, 16));
  }

  async function submitReserve() {
    if (!pickedStation) return;
    setSubmitting(true);
    const res = await reserveStation({
      stationId: pickedStation.id,
      startAt: new Date(startAt).toISOString(),
      durationMinutes: duration,
    });
    setSubmitting(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Reservation confirmed.");
    setPickedStation(null);
    load();
  }

  async function submitJoinQueue(stationId: string) {
    setSubmitting(true);
    const res = await joinStationQueue({ stationId, durationMinutes: duration });
    setSubmitting(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("You're in the queue.");
    load();
  }

  async function handleConfirmHold() {
    if (!active) return;
    const res = await confirmHold(active.id);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Reservation scheduled.");
    load();
  }

  function openCancelDialog(reservation: PortalReservation) {
    setCancelTarget(reservation);
    if (reservation.fromQueue) {
      setCancelPreview({ isLate: false, feeAmount: null });
      return;
    }
    if (!policy || !reservation.startAt) {
      setCancelPreview(null);
      return;
    }
    const lateThreshold =
      new Date(reservation.startAt).getTime() - policy.lateCancellationWindowMinutes * 60_000;
    const isLate = Date.now() >= lateThreshold;
    setCancelPreview({
      isLate,
      feeAmount: isLate && policy.cancellationFeeEnabled ? policy.cancellationFeeAmount : null,
    });
  }

  async function submitCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    const res = await cancelReservation(cancelTarget.id);
    setCancelling(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Reservation cancelled.");
    setCancelTarget(null);
    load();
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {active && (
        <Card>
          <CardHeader>
            <CardTitle>
              {active.status === "pending"
                ? `You are #${queuePosition ?? "?"} in line`
                : active.status === "hold"
                  ? "YOUR PC IS READY"
                  : "Your reservation"}
            </CardTitle>
            <CardDescription>
              {active.status === "hold" && (
                <span>
                  Held for you — this hold is FREE. You have {holdCountdown ?? "…"} remaining to claim it
                  by logging in at the station, or confirm it below.
                </span>
              )}
              {active.status === "pending" && <span>Waiting for the station to become free. This is FREE.</span>}
              {(active.status === "confirmed" || active.status === "checked_in") && (
                <span>
                  Scheduled {active.startAt ? new Date(active.startAt).toLocaleString() : ""}
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardFooter className="gap-2">
            {active.status === "hold" && (
              <Button onClick={handleConfirmHold}>Confirm reservation</Button>
            )}
            <Button variant="outline" onClick={() => openCancelDialog(active)}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      )}

      {!active && reservationBan && (
        <Card>
          <CardHeader>
            <CardTitle>Reservations unavailable</CardTitle>
            <CardDescription>
              Your reservation privileges are temporarily suspended. Available again:{" "}
              {formatUnbanDate(reservationBan.expiresAt)}.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {!active && queueBan && (
        <Card>
          <CardHeader>
            <CardTitle>Queue unavailable</CardTitle>
            <CardDescription>
              You missed a previous queue hold. You can join the queue again after:{" "}
              {formatUnbanDate(queueBan.expiresAt)}.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {branches.flatMap((branch) =>
          branch.stations.map((station) => (
            <Card key={station.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  {station.name}
                  <Badge variant={station.status === "available" ? "default" : "secondary"}>
                    {station.status === "available" ? "AVAILABLE" : station.status.toUpperCase()}
                  </Badge>
                </CardTitle>
                <CardDescription>{branch.name}</CardDescription>
              </CardHeader>
              <CardFooter>
                {!!active ? (
                  <Button variant="outline" disabled className="w-full">
                    You already have an active reservation
                  </Button>
                ) : reservationBan || queueBan ? (
                  <Button variant="outline" disabled className="w-full">
                    Unavailable
                  </Button>
                ) : station.status === "available" ? (
                  <Button className="w-full" onClick={() => openReserveDialog(station)}>
                    Reserve PC
                  </Button>
                ) : station.status === "occupied" ? (
                  <Button variant="outline" className="w-full" onClick={() => submitJoinQueue(station.id)}>
                    Join Queue
                  </Button>
                ) : (
                  <Button variant="outline" disabled className="w-full">
                    Not bookable
                  </Button>
                )}
              </CardFooter>
            </Card>
          )),
        )}
      </div>

      <Dialog open={!!pickedStation} onOpenChange={(open) => !open && setPickedStation(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reserve {pickedStation?.name}</DialogTitle>
            <DialogDescription>
              Holding the PC is FREE. Pick a start time and duration.
              {policy && (
                <>
                  {" "}You can schedule up to {policy.reservationAdvanceWindowMinutes} minutes from now.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="startAt">Start time</Label>
              <Input
                id="startAt"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Duration</Label>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((mins) => (
                    <SelectItem key={mins} value={String(mins)}>
                      {mins / 60} hour{mins > 60 ? "s" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickedStation(null)}>
              Cancel
            </Button>
            <Button onClick={submitReserve} disabled={submitting}>
              Reserve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel reservation?</DialogTitle>
            <DialogDescription>
              {cancelTarget?.fromQueue ? (
                "This is a queue cancellation — it's free, no penalty."
              ) : cancelPreview?.isLate ? (
                <>
                  A ₱{cancelPreview.feeAmount ?? "0"} cancellation fee will apply. Your reservation
                  privileges will also be suspended for a period.
                </>
              ) : (
                "No cancellation fee will apply."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              Keep reservation
            </Button>
            <Button variant="destructive" onClick={submitCancel} disabled={cancelling}>
              Cancel reservation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
