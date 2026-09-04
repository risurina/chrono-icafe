import type { LoyaltyTier } from "./contracts";

/**
 * Tier thresholds, kept from oikos as a reasonable default (see
 * .ai/plans/chrono/active/loyalty/README.md, Pass 2 — "Tier thresholds").
 * Ordered highest-first so `tierFor` can early-return on the first match.
 *
 * Lives here (not service.ts) so the read path (`computeLevel`, member
 * portal) and the write path (`applyPointsDelta`, via service.ts's
 * re-export) share the exact same curve and can never drift.
 */
export const LOYALTY_TIERS = [
  { key: "platinum", minLifetimePoints: 5000 },
  { key: "gold", minLifetimePoints: 3000 },
  { key: "silver", minLifetimePoints: 1000 },
  { key: "bronze", minLifetimePoints: 0 },
] as const;

/** First LOYALTY_TIERS entry whose threshold the lifetime total clears. */
export function tierFor(lifetimePoints: number): (typeof LOYALTY_TIERS)[number]["key"] {
  for (const tier of LOYALTY_TIERS) {
    if (lifetimePoints >= tier.minLifetimePoints) return tier.key;
  }
  return "bronze";
}

export type LoyaltyCurve = readonly { key: LoyaltyTier; minLifetimePoints: number }[];

export type LevelInfo = {
  tier: LoyaltyTier;
  nextTier: LoyaltyTier | null;
  pointsToNext: number | null;
  progressPercent: number;
};

/**
 * Pure function: derives a member-facing "level" from lifetime loyalty
 * points, sharing `LOYALTY_TIERS`/`tierFor` with the write path
 * (service.ts's `applyPointsDelta`) so the two can never disagree about
 * which tier a given lifetime total belongs to.
 *
 * `progressPercent` is progress toward `nextTier` within the current tier's
 * band (0 at the current tier's own floor, 100 at the next tier's floor).
 * The top tier (platinum) has no `nextTier`/`pointsToNext` and reports 100%.
 */
export function computeLevel(
  lifetimePoints: number,
  curve: LoyaltyCurve = LOYALTY_TIERS,
): LevelInfo {
  assertValidCurve(curve);
  const tier = tierFor(lifetimePoints);
  const sortedAsc = [...curve].sort((a, b) => a.minLifetimePoints - b.minLifetimePoints);
  const currentIndex = sortedAsc.findIndex((t) => t.key === tier);
  const currentFloor = sortedAsc[currentIndex]!.minLifetimePoints;
  const next = sortedAsc[currentIndex + 1] ?? null;

  if (!next) {
    return { tier, nextTier: null, pointsToNext: null, progressPercent: 100 };
  }

  const band = next.minLifetimePoints - currentFloor;
  const progressInBand = lifetimePoints - currentFloor;
  const progressPercent =
    band <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((progressInBand / band) * 100)));

  return {
    tier,
    nextTier: next.key,
    pointsToNext: Math.max(0, next.minLifetimePoints - lifetimePoints),
    progressPercent,
  };
}

/**
 * Guards against a malformed curve (empty, or missing a zero-floor tier) —
 * `tierFor`'s fallback to "bronze" would otherwise silently mask a bad
 * curve passed to `computeLevel` in a future tenant-configurable-thresholds
 * follow-up.
 */
export function assertValidCurve(curve: LoyaltyCurve): void {
  if (curve.length === 0) {
    throw new Error("Loyalty curve must have at least one tier");
  }
  const hasFloor = curve.some((t) => t.minLifetimePoints <= 0);
  if (!hasFloor) {
    throw new Error("Loyalty curve must include a tier with minLifetimePoints <= 0");
  }
}
