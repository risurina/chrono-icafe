/**
 * Unit test for `rankBusinessesByDemand()` (growth-loop-hardening Phase 10).
 * Pure function, fixture-driven — no DB, no HTTP. Standalone tsx script (no
 * unit-test runner in this repo), mirroring this module's own conventions.
 */
import { rankBusinessesByDemand, DISCOVERY_DEMAND_BOOST_SLOTS } from "./contracts";

type Fixture = { name: string };

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function names(list: Fixture[]): string[] {
  return list.map((o) => o.name);
}

// ── Fixture: 5 alphabetically-ordered businesses, as the SQL query would
//    already hand them in (name ASC). ──
const orgs: Fixture[] = [
  { name: "Alpha Cafe" },
  { name: "Bravo Gaming" },
  { name: "Charlie Lounge" },
  { name: "Delta Netcafe" },
  { name: "Echo Arcade" },
];

// 1. Zero demand across every business → unchanged alphabetical order.
{
  const ranked = rankBusinessesByDemand(orgs, new Map());
  check(
    "zero-demand tenants see unchanged (alphabetical) ordering",
    JSON.stringify(names(ranked)) === JSON.stringify(names(orgs)),
    JSON.stringify(names(ranked)),
  );
}

// 2. One business has demand → it moves to the front; everyone else keeps
//    their original relative order.
{
  const demand = new Map([["charlie lounge", 5]]);
  const ranked = rankBusinessesByDemand(orgs, demand);
  check(
    "a single business with demand > 0 is pulled to the front",
    JSON.stringify(names(ranked)) ===
      JSON.stringify(["Charlie Lounge", "Alpha Cafe", "Bravo Gaming", "Delta Netcafe", "Echo Arcade"]),
    JSON.stringify(names(ranked)),
  );
}

// 3. More than DISCOVERY_DEMAND_BOOST_SLOTS businesses have demand → only the
//    top N (by demand desc) are boosted; the rest — INCLUDING any
//    demand-having business beyond the cap — keep their original order.
{
  check("boost cap is exactly 3 (sanity on the fixture below)", DISCOVERY_DEMAND_BOOST_SLOTS === 3);
  const demand = new Map([
    ["alpha cafe", 2],
    ["bravo gaming", 10],
    ["charlie lounge", 1],
    ["delta netcafe", 7],
    ["echo arcade", 3],
  ]);
  const ranked = rankBusinessesByDemand(orgs, demand);
  // Highest 3 by demand: Bravo(10), Delta(7), Echo(3) — in that order.
  // Remainder (Alpha, Charlie) keep their ORIGINAL alphabetical order, even
  // though both still have nonzero demand — the cap is a hard slot count,
  // not "everyone with demand gets sorted".
  check(
    "only the top 3 by demand are boosted; the rest keep original order",
    JSON.stringify(names(ranked)) ===
      JSON.stringify(["Bravo Gaming", "Delta Netcafe", "Echo Arcade", "Alpha Cafe", "Charlie Lounge"]),
    JSON.stringify(names(ranked)),
  );
}

// 4. Alphabetical tiebreak among equal demand counts.
{
  const demand = new Map([
    ["echo arcade", 4],
    ["bravo gaming", 4],
  ]);
  const ranked = rankBusinessesByDemand(orgs, demand);
  check(
    "equal demand counts break alphabetically",
    JSON.stringify(names(ranked).slice(0, 2)) === JSON.stringify(["Bravo Gaming", "Echo Arcade"]),
    JSON.stringify(names(ranked)),
  );
}

// 5. A demand entry for a business name not in this page's org list has no
//    effect (defensive — the route bounds the query to exactly this page's
//    normalized names, but the ranker itself must not assume that).
{
  const demand = new Map([["some other cafe", 999]]);
  const ranked = rankBusinessesByDemand(orgs, demand);
  check(
    "a demand entry for an unrelated business name is a no-op",
    JSON.stringify(names(ranked)) === JSON.stringify(names(orgs)),
    JSON.stringify(names(ranked)),
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("✅ PASS");
