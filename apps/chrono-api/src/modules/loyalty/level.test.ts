import assert from "node:assert/strict";
import { computeLevel, assertValidCurve, LOYALTY_TIERS, tierFor } from "./level";

function run() {
  // No points -> bronze, 0% progress toward silver at 1000.
  {
    const level = computeLevel(0);
    assert.equal(level.tier, "bronze");
    assert.equal(level.nextTier, "silver");
    assert.equal(level.pointsToNext, 1000);
    assert.equal(level.progressPercent, 0);
  }

  // Midway between bronze and silver.
  {
    const level = computeLevel(500);
    assert.equal(level.tier, "bronze");
    assert.equal(level.nextTier, "silver");
    assert.equal(level.pointsToNext, 500);
    assert.equal(level.progressPercent, 50);
  }

  // Exactly at a threshold promotes.
  {
    const level = computeLevel(1000);
    assert.equal(level.tier, "silver");
    assert.equal(level.nextTier, "gold");
  }

  // Top tier has no next tier and reports 100%.
  {
    const level = computeLevel(5000);
    assert.equal(level.tier, "platinum");
    assert.equal(level.nextTier, null);
    assert.equal(level.pointsToNext, null);
    assert.equal(level.progressPercent, 100);
  }

  // Beyond the top tier's floor still reports platinum/100%.
  {
    const level = computeLevel(999_999);
    assert.equal(level.tier, "platinum");
    assert.equal(level.progressPercent, 100);
  }

  // tierFor and computeLevel never disagree for the same input.
  for (const points of [0, 1, 999, 1000, 2999, 3000, 4999, 5000, 100_000]) {
    assert.equal(computeLevel(points).tier, tierFor(points));
  }

  // A malformed curve (no zero-floor tier) throws rather than silently
  // falling back.
  assert.throws(() => assertValidCurve([{ key: "gold", minLifetimePoints: 100 } as any]));
  assert.throws(() => assertValidCurve([] as any));
  assert.doesNotThrow(() => assertValidCurve(LOYALTY_TIERS));

  console.log("loyalty level: all assertions passed");
}

run();
