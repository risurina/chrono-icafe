import assert from "node:assert/strict";
import { computeOpenStatus, type HoursConfig } from "./hours";

const TZ = "Asia/Manila"; // UTC+8, no DST — deterministic against UTC instants.

function run() {
  // No hoursConfig -> null, never a fabricated status.
  assert.equal(computeOpenStatus(null, new Date(), TZ), null);
  assert.equal(computeOpenStatus(undefined, new Date(), TZ), null);

  // Wednesday 2026-09-09 is a Wednesday in Manila.
  const config: HoursConfig = {
    wednesday: { open: "10:00", close: "22:00" },
    thursday: "closed",
    friday: { open: "10:00", close: "22:00" },
  };

  // 2026-09-09T04:00:00Z = 12:00 PM Manila time (UTC+8) -> within window.
  {
    const status = computeOpenStatus(config, new Date("2026-09-09T04:00:00Z"), TZ);
    assert.deepEqual(status, { isOpen: true, opensAt: null });
  }

  // 2026-09-09T01:00:00Z = 09:00 AM Manila time -> before opening, same day.
  {
    const status = computeOpenStatus(config, new Date("2026-09-09T01:00:00Z"), TZ);
    assert.deepEqual(status, { isOpen: false, opensAt: "10:00" });
  }

  // 2026-09-09T15:00:00Z = 11:00 PM Manila time -> after closing; Thursday is
  // explicitly closed, so the next opening is Friday.
  {
    const status = computeOpenStatus(config, new Date("2026-09-09T15:00:00Z"), TZ);
    assert.deepEqual(status, { isOpen: false, opensAt: "10:00" });
  }

  // A "24h" day is always open now, never an "opens at" line.
  {
    const status = computeOpenStatus(
      { wednesday: "24h" },
      new Date("2026-09-09T15:00:00Z"),
      TZ,
    );
    assert.deepEqual(status, { isOpen: true, opensAt: null });
  }

  // Overnight window (crosses midnight): open 18:00, close 02:00.
  {
    const overnight: HoursConfig = { wednesday: { open: "18:00", close: "02:00" } };
    // 2026-09-09T13:00:00Z = 09:00 PM Manila Wednesday -> inside the window.
    assert.deepEqual(
      computeOpenStatus(overnight, new Date("2026-09-09T13:00:00Z"), TZ),
      { isOpen: true, opensAt: null },
    );
    // 2026-09-10T00:00:00Z = 08:00 AM Manila Thursday -> after the 02:00 close.
    // No other day is configured, so the 7-day scan wraps all the way back to
    // next Wednesday's opening.
    assert.deepEqual(
      computeOpenStatus(overnight, new Date("2026-09-10T00:00:00Z"), TZ),
      { isOpen: false, opensAt: "18:00" },
    );
  }

  // A day with no entry at all is treated as closed.
  {
    const status = computeOpenStatus(
      { monday: { open: "09:00", close: "17:00" } },
      new Date("2026-09-09T04:00:00Z"), // Wednesday, unconfigured -> closed
      TZ,
    );
    assert.equal(status?.isOpen, false);
    assert.equal(status?.opensAt, "09:00"); // next Monday
  }

  console.log("branch hours: all assertions passed");
}

run();
