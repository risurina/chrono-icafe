import { api, unwrap, type Result } from "./client";

export type LoyaltyTier = "bronze" | "silver" | "gold" | "platinum";

export type LevelInfo = {
  tier: LoyaltyTier;
  nextTier: LoyaltyTier | null;
  pointsToNext: number | null;
  progressPercent: number;
};

export type LoyaltyMe = {
  account: { pointsBalance: number; lifetimePoints: number; tier: LoyaltyTier } | null;
  level: LevelInfo;
  memberSince: string;
};

export function getMyLoyalty(): Promise<Result<LoyaltyMe>> {
  return api.portal.loyalty.me.$get().then((res) => unwrap(res, (json) => json as LoyaltyMe));
}
