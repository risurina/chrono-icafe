"use client";

import { useEffect, useRef } from "react";

/**
 * Periodically re-runs `refresh` while `enabled` is true, pausing whenever
 * the tab is backgrounded (Page Visibility API) and immediately refreshing
 * once it becomes visible again — so a member staring at a session they've
 * left in a background tab doesn't burn requests, but flipping back to the
 * tab always shows current data rather than waiting out the rest of the
 * interval.
 *
 * member-portal-v2 phase 5 (session live updates) chose polling over wiring
 * the shared realtime provider (`agora/realtime`) into the member session
 * view: no one has reviewed a realtime integration for this surface yet, and
 * the prior explicit decision here was "no realtime for members" — polling
 * is the lighter-weight, lower-risk option that doesn't require touching the
 * connection registry or making an unreviewed infra call. `intervalMs` is
 * deliberately not proportional to session cost precision (the backend never
 * estimates an in-progress charge) — it only needs to be frequent enough
 * that a status change (paused/resumed/ended/extended) or a display copy
 * change land promptly. If this surface ever needs sub-second precision or
 * push-based updates, that is the seam to revisit — not a shorter interval.
 */
export function useLiveRefresh(refresh: () => void | Promise<void>, intervalMs: number, enabled: boolean) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      void refreshRef.current();
    };

    const interval = window.setInterval(tick, intervalMs);

    function onVisibilityChange() {
      if (!document.hidden) tick();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs]);
}
