/**
 * Shared session elapsed/remaining/duration-format math.
 *
 * Extracted verbatim from `dashboard/sessions/page.tsx`'s own local copy (no
 * behavior change) so the Station Control board doesn't reimplement — or
 * subtly diverge from — the same elapsed/paused-time computation a third
 * time. See `.ai/plans/chrono/active/station-control-grouping/README.md`,
 * Phase 3.
 */

export type SessionTimeInput = {
  status: string; // "active" | "paused" | "ended"
  startedAt: string;
  pausedAt: string | null;
  endedAt?: string | null;
};

export function computeElapsedSeconds(s: SessionTimeInput, nowMs: number): number {
  if (s.status === "ended") {
    if (s.endedAt) {
      return Math.floor((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000);
    }
    return 0;
  }

  const start = new Date(s.startedAt).getTime();
  let elapsed = Math.floor((nowMs - start) / 1000);

  if (s.status === "paused" && s.pausedAt) {
    const pauseStart = new Date(s.pausedAt).getTime();
    elapsed -= Math.floor((nowMs - pauseStart) / 1000);
  }

  return Math.max(0, elapsed);
}

/**
 * Seconds remaining until `scheduledEndAt`, clamped to 0 — never negative.
 * Callers should flag an overdue (0-remaining) station rather than show a
 * negative countdown.
 *
 * Deliberately keeps draining in real time even while the session is
 * `paused`, unlike `computeElapsedSeconds` (which freezes on pause).
 * `scheduledEndAt` is a fixed wall-clock deadline that `session/routes.ts`'s
 * pause/resume handlers never shift — only `pausedDurationSeconds` (a
 * billing-time adjustment) and `pausedAt` change on pause/resume. So a pause
 * does not grant the station extra allotted time; the deadline stands
 * regardless. If a paused session needs its deadline pushed back, that is
 * what "Add Time" (`extend`) is for. Callers that want to visually
 * distinguish "paused" from "counting down" should badge the session status
 * separately (see `StationControlBoard`'s card header), not repurpose this
 * function into a second timer mode.
 */
export function computeRemainingSeconds(scheduledEndAt: string, nowMs: number): number {
  const remaining = Math.floor((new Date(scheduledEndAt).getTime() - nowMs) / 1000);
  return Math.max(0, remaining);
}

export function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
