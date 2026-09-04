/**
 * Pure, timezone-aware "today's usage" aggregation over already-ended
 * sessions — never estimates the still-running session's cost server-side
 * (an active session's final amount isn't known until it actually ends).
 *
 * "Today" is computed in the branch's own IANA timezone via
 * `Intl.DateTimeFormat`, not the server's local time or naive UTC midnight —
 * a branch in `Asia/Manila` and a server running in UTC must agree on when
 * "today" starts.
 */

export type EndedSessionForUsage = {
  startedAt: Date;
  actualBillableSeconds: number | null;
  amountCharged: string | null; // decimal string, matches the schema's money convention
  currency: string;
};

export type TodayUsage = {
  billableSeconds: number;
  sessionCount: number;
  amountCharged: string;
  currency: string;
  timezone: string;
};

/** YYYY-MM-DD for `date` as observed in `timezone` — used to bucket "today". */
function dateKeyInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Sums billable seconds + amount charged across `sessions` that both ended
 * (the caller pre-filters to ended sessions) and STARTED on "today" in
 * `timezone`, relative to `now`. Defaults `currency` to "PHP" when there are
 * no matching sessions (matches wallet/credit portal routes' own
 * no-data-yet default).
 */
export function summarizeTodayUsage(
  sessions: EndedSessionForUsage[],
  timezone: string,
  now: Date = new Date(),
): TodayUsage {
  const todayKey = dateKeyInTimezone(now, timezone);
  const todaysSessions = sessions.filter((s) => dateKeyInTimezone(s.startedAt, timezone) === todayKey);

  const billableSeconds = todaysSessions.reduce((sum, s) => sum + (s.actualBillableSeconds ?? 0), 0);
  const amountChargedTotal = todaysSessions.reduce((sum, s) => sum + Number(s.amountCharged ?? 0), 0);
  const currency = todaysSessions[0]?.currency ?? "PHP";

  return {
    billableSeconds,
    sessionCount: todaysSessions.length,
    amountCharged: amountChargedTotal.toFixed(2),
    currency,
    timezone,
  };
}
