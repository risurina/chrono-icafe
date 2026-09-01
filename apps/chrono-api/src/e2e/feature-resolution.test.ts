/**
 * Unit tests for the pure feature-flag resolution helpers
 * (`.ai/plans/archive/platform-feature-management`). Standalone tsx script
 * (`pnpm --filter @agora/api test:feature-resolution`) — mirrors the inline
 * assertion style of `permissions.test.ts`; the repo has no unit-test runner.
 *
 * `resolveFeatureState` / `rolloutBucket` are DB-free, so this proves the
 * 5-step precedence order and rollout determinism without seeding any rows.
 */
// Pure helpers, but importing `agora/server` pulls in the db client, which
// requires a driver — use in-process PGlite so no real DATABASE_URL is needed.
process.env.DB_DRIVER = "pglite";

const { resolveFeatureState, rolloutBucket } = await import("agora/server");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = {
  status: "active" as const,
  override: null as boolean | null,
  planAllowed: true,
  rolloutPercentage: null as number | null,
  bucket: 0,
  globalDefault: false,
};

console.log("\nFeature resolution — 5-step precedence order");

// 1. Kill switch beats everything, including an explicit per-tenant enable.
{
  const r = resolveFeatureState({
    ...base,
    status: "disabled",
    override: true,
    planAllowed: true,
    globalDefault: true,
  });
  check("kill switch forces OFF even with override=true", r.enabled === false && r.reason === "killed");
}

// 2. Explicit override beats plan exclusion and rollout and default.
{
  const on = resolveFeatureState({
    ...base,
    override: true,
    planAllowed: false, // would exclude
    rolloutPercentage: 0, // would be off
    globalDefault: false,
  });
  check("override=true beats plan exclusion + rollout", on.enabled === true && on.reason === "override");
  const off = resolveFeatureState({ ...base, override: false, globalDefault: true });
  check("override=false beats globalDefault=true", off.enabled === false && off.reason === "override");
}

// 3. Plan availability gates when no override.
{
  const r = resolveFeatureState({ ...base, planAllowed: false, globalDefault: true });
  check("plan-excluded forces OFF when no override", r.enabled === false && r.reason === "plan_excluded");
}

// 4. Rollout is deterministic and threshold-correct.
{
  const under = resolveFeatureState({ ...base, rolloutPercentage: 50, bucket: 10 });
  check("rollout ON when bucket < percentage", under.enabled === true && under.reason === "rollout");
  const over = resolveFeatureState({ ...base, rolloutPercentage: 50, bucket: 80 });
  check("rollout OFF when bucket >= percentage", over.enabled === false && over.reason === "rollout");
  const full = resolveFeatureState({ ...base, rolloutPercentage: 100, globalDefault: true });
  check("rollout=100 falls through to default", full.reason === "default" && full.enabled === true);
}

// 5. Global default is the fallthrough.
{
  const on = resolveFeatureState({ ...base, globalDefault: true });
  check("globalDefault=true is fallthrough ON", on.enabled === true && on.reason === "default");
  const off = resolveFeatureState({ ...base, globalDefault: false });
  check("globalDefault=false is fallthrough OFF", off.enabled === false && off.reason === "default");
}

console.log("\nRollout bucketing — deterministic 0..99");
{
  const a = rolloutBucket("tenant-abc", "reports.advanced");
  const b = rolloutBucket("tenant-abc", "reports.advanced");
  check("same (tenant,key) → same bucket", a === b);
  check("bucket in [0,99]", a >= 0 && a <= 99, String(a));
  const c = rolloutBucket("tenant-xyz", "reports.advanced");
  check("different tenant → (usually) different bucket path is stable", typeof c === "number" && c >= 0 && c <= 99);
  // A tenant at bucket b is IN the rollout at any percentage > b, OUT below — monotonic.
  const t = rolloutBucket("tenant-mono", "api.access");
  const inAt = resolveFeatureState({ ...base, rolloutPercentage: Math.min(100, t + 1), bucket: t });
  const outAt = resolveFeatureState({ ...base, rolloutPercentage: t, bucket: t });
  check("rollout membership is monotonic in percentage", inAt.enabled === true && outAt.enabled === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FEATURE RESOLUTION: FAIL ❌");
  process.exit(1);
}
console.log("FEATURE RESOLUTION: PASS ✅");
process.exit(0);
