/**
 * Structured operating hours + the dynamic open/closed status they compute.
 *
 * Pure, no DB access — `computeOpenStatus` takes the branch's own
 * `hoursConfig`/`timezone` plus a caller-supplied `now` so it's exercised the
 * same way at read time (`/public/venue-info`) and in unit tests.
 */

export type DayKey =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

/** A day's window: an explicit open/close pair, always open, or closed. */
export type DayHours = { open: string; close: string } | "24h" | "closed";

/**
 * One entry per day of the week. A day with no entry (or `undefined`) is
 * treated as closed — the same "absent means off" convention the rest of the
 * config cascade already uses (`.ai/rules/business-app.md`'s legacy-layer
 * precedent).
 */
export type HoursConfig = Partial<Record<DayKey, DayHours>>;

export type OpenStatus = {
  isOpen: boolean;
  /** "HH:MM" (24h), or `null` when open now, or when no future opening was found. */
  opensAt: string | null;
};

const DAY_ORDER: readonly DayKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** "HH:MM" -> minutes since midnight. Assumes a validated, well-formed input. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Resolves the branch's local weekday + minute-of-day for `now`, in
 * `timezone`, using `Intl` rather than a date library — this app has no
 * timezone-math dependency yet and the only operation needed here is
 * "what's the local wall-clock day/time right now".
 */
function localDayAndMinute(now: Date, timezone: string): { day: DayKey; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value.toLowerCase() ?? "sunday";
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  // Some ICU implementations report midnight as "24" under hour12:false.
  if (hour === 24) hour = 0;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  return { day: weekday as DayKey, minute: hour * 60 + minute };
}

/** Is `minute` inside the [open, close) window, correctly handling an overnight window (close <= open). */
function isWithinWindow(minute: number, open: number, close: number): boolean {
  if (close > open) return minute >= open && minute < close;
  // Overnight window, e.g. open 18:00, close 02:00.
  return minute >= open || minute < close;
}

/**
 * Computes the venue's current open/closed status from its structured hours.
 *
 * Returns `null` when `hoursConfig` is absent — the caller must fall back to
 * the plain-text `operatingHours` display, never fabricate a status.
 *
 * A day configured `"24h"` always reports `{ isOpen: true, opensAt: null }` —
 * never an "opens at" line, per the locked product decision.
 */
export function computeOpenStatus(
  hoursConfig: HoursConfig | null | undefined,
  now: Date,
  timezone: string,
): OpenStatus | null {
  if (!hoursConfig) return null;

  const { day, minute } = localDayAndMinute(now, timezone);
  const todayIdx = DAY_ORDER.indexOf(day);
  const today = hoursConfig[day];

  if (today === "24h") {
    return { isOpen: true, opensAt: null };
  }

  if (today && today !== "closed") {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (isWithinWindow(minute, open, close)) {
      return { isOpen: true, opensAt: null };
    }
  }

  // Closed right now — scan forward up to 7 days (including today, for a
  // window that hasn't started yet) for the next opening.
  for (let offset = 0; offset < 7; offset++) {
    const dayKey = DAY_ORDER[(todayIdx + offset) % 7]!;
    const hours = hoursConfig[dayKey];
    if (!hours || hours === "closed") continue;

    if (hours === "24h") {
      return { isOpen: false, opensAt: "00:00" };
    }

    if (offset === 0) {
      // Today's window exists but hasn't started yet (already confirmed not
      // currently open, above) — only a valid "opens at" if it's still ahead.
      const open = toMinutes(hours.open);
      if (minute < open) {
        return { isOpen: false, opensAt: hours.open };
      }
      continue;
    }

    return { isOpen: false, opensAt: hours.open };
  }

  // No day in the config has any hours at all.
  return { isOpen: false, opensAt: null };
}
