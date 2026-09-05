import { api } from "@/lib/rpc";
import { toast } from "agora/ui";

const DEFAULT_STATION_GROUPS = [
  { name: "Regular", code: "regular", hourlyRate: 30, memberRate: 20 },
  { name: "Premium", code: "premium", hourlyRate: 40, memberRate: 30 },
  { name: "VIP", code: "vip", hourlyRate: 50, memberRate: 40 },
] as const;

/**
 * Seeds a brand-new tenant with a "Main" branch and Regular/Premium/VIP
 * station groups so a fresh sign-up starts with a working floor instead of
 * an empty dashboard. No-ops if a branch already exists.
 */
export async function provisionDefaultsIfNeeded(): Promise<void> {
  const existing = await api.rpc.branches.$get({ query: { pageSize: "1" } });
  if (!existing.ok || (await existing.json()).meta.totalItems > 0) return;

  const created = await api.rpc.branches.$post({ json: { name: "Main" } });
  let branchId: string | undefined;
  if (created.ok) {
    branchId = (await created.json()).branch?.id;
  } else if ((created.status as number) === 409) {
    const retry = await api.rpc.branches.$get({ query: { pageSize: "1" } });
    if (retry.ok) branchId = (await retry.json()).items[0]?.id;
  }
  if (!branchId) return;

  await Promise.all(
    DEFAULT_STATION_GROUPS.map((group) =>
      api.rpc.stations.groups.$post({ json: { branchId, ...group } }),
    ),
  );

  toast.success(
    'Set up a default "Main" branch with Regular, Premium, and VIP station groups — customize anytime from Setup.',
  );
}
