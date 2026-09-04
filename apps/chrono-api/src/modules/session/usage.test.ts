import assert from "node:assert/strict";
import { summarizeTodayUsage } from "./usage";

function run() {
  const tz = "Asia/Manila";
  // "now" = 2026-01-15T10:00:00Z -> 2026-01-15T18:00:00+08:00 in Manila.
  const now = new Date("2026-01-15T10:00:00.000Z");

  // Started earlier today in Manila (2026-01-15T02:00Z = 10:00 Manila).
  const todaySession = {
    startedAt: new Date("2026-01-15T02:00:00.000Z"),
    actualBillableSeconds: 3600,
    amountCharged: "50.00",
    currency: "PHP",
  };
  // Started "yesterday" in Manila even though same UTC calendar day boundary
  // logic could get it wrong (2026-01-14T20:00Z = 2026-01-15T04:00 Manila —
  // still today; use a genuinely earlier one instead).
  const yesterdaySession = {
    startedAt: new Date("2026-01-14T10:00:00.000Z"), // 2026-01-14T18:00 Manila
    actualBillableSeconds: 1800,
    amountCharged: "25.00",
    currency: "PHP",
  };

  const result = summarizeTodayUsage([todaySession, yesterdaySession], tz, now);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.billableSeconds, 3600);
  assert.equal(result.amountCharged, "50.00");
  assert.equal(result.currency, "PHP");
  assert.equal(result.timezone, tz);

  // No sessions today -> zeroed out, default currency.
  const empty = summarizeTodayUsage([yesterdaySession], tz, now);
  assert.equal(empty.sessionCount, 0);
  assert.equal(empty.billableSeconds, 0);
  assert.equal(empty.amountCharged, "0.00");
  assert.equal(empty.currency, "PHP");

  // Null actualBillableSeconds/amountCharged treated as zero, not NaN.
  const nullish = summarizeTodayUsage(
    [{ ...todaySession, actualBillableSeconds: null, amountCharged: null }],
    tz,
    now,
  );
  assert.equal(nullish.billableSeconds, 0);
  assert.equal(nullish.amountCharged, "0.00");

  console.log("session usage: all assertions passed");
}

run();
