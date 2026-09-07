import { api, unwrap, type Result } from "./client";

// Mirrors `loyalty.ts`'s `getMyLoyalty()` shape exactly. `recentBranch` is
// `null` for a member with no qualifying reservation/session activity yet —
// this must render "—" on the page, never a fabricated branch name.
export type RecentBranch = {
  branchId: string;
  branchName: string;
  lastActivityAt: string;
} | null;

export type RecentBranchMe = {
  recentBranch: RecentBranch;
};

export function getMyRecentBranch(): Promise<Result<RecentBranchMe>> {
  return api.portal.members.me["recent-branch"].$get().then((res) =>
    unwrap(res, (json) => json as RecentBranchMe),
  );
}
