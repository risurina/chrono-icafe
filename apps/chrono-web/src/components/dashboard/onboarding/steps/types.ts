import { useEffect, useState } from "react";
import type { OnboardingChecklistItemState } from "agora";
import { api } from "@/lib/rpc";

/** Props every step form shares. `onDone` triggers the parent's refetch. */
export type StepFormProps = {
  item: OnboardingChecklistItemState;
  onDone: () => void;
};

/**
 * The tenant's first branch, for the steps that need a `branchId` but come
 * after "create your first branch" in the wizard (so exactly one branch
 * exists by the time these render) — avoids a branch-picker for a single
 * option. `null` while loading or if genuinely none exist yet.
 */
export function useFirstBranch(): { id: string; name: string } | null {
  const [branch, setBranch] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.rpc.branches.$get({ query: { page: "1", pageSize: "1" } }).then(async (res) => {
      if (cancelled || !res.ok) return;
      const body = await res.json();
      const first = body.items[0];
      if (first) setBranch({ id: first.id, name: first.name });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return branch;
}
