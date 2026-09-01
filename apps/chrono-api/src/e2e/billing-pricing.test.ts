/**
 * Unit tests for the multi-currency pricing resolver
 * (unified-billing-price-source Phase 2). Standalone tsx script, mirroring
 * `billing-transactions.test.ts`'s inline-assertion style. No DB, no network:
 * `toProviderAmount`/`resolveCurrencyPure`/`mapTimezoneToCurrency` are all pure
 * with respect to their inputs — this file never exercises `checkoutAmountFor`/
 * `pinCheckoutCurrency`/`resolveCheckoutCurrency` (those DO touch the DB).
 *
 * Unlike `billing-transactions.test.ts` (which only imports from `agora/billing`,
 * a module with zero DB imports), this file imports from `agora/billing/server`,
 * which imports `adminDb` at module load — so `DB_DRIVER=pglite` MUST be set
 * before the process starts (module imports are evaluated before any top-level
 * statement runs), not assigned here. Run via
 * `DB_DRIVER=pglite pnpm --filter @agora/api test:billing-pricing`.
 */

import {
  toProviderAmount,
  resolveCurrencyPure,
  mapTimezoneToCurrency,
} from "agora/billing/server";

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

// ── toProviderAmount: per-driver unit convention ──
check(
  "Stripe: 49.00 usd -> 4900 (minor units)",
  toProviderAmount("49.00", "usd", "stripe") === 4900,
);
check(
  "PayMongo: 100.00 php -> 10000 centavos (minor units)",
  toProviderAmount("100.00", "php", "paymongo") === 10000,
);
check(
  "Xendit: 150000 php -> 150000 WHOLE units (never x100 -- would be a 100x overcharge)",
  toProviderAmount("150000", "php", "xendit") === 150000,
);
check(
  "Stripe: zero-decimal currency (jpy) -> whole units, not minor",
  toProviderAmount("1500", "jpy", "stripe") === 1500,
);
check(
  "PayMongo: zero-decimal currency (jpy) -> whole units too",
  toProviderAmount("1500", "jpy", "paymongo") === 1500,
);
check(
  "Xendit: zero-decimal currency unaffected (already whole units)",
  toProviderAmount("1500", "jpy", "xendit") === 1500,
);

// ── toProviderAmount: rounding is round-half-up ──
check(
  "round-half-up: 19.995 usd stripe -> 2000 (not 1999)",
  toProviderAmount("19.995", "usd", "stripe") === 2000,
);
check(
  "round-half-up: 19.994 usd stripe -> 1999",
  toProviderAmount("19.994", "usd", "stripe") === 1999,
);

// ── toProviderAmount: rejects non-finite input ──
let threwOnNaN = false;
try {
  toProviderAmount("not-a-number", "usd", "stripe");
} catch {
  threwOnNaN = true;
}
check("toProviderAmount rejects a non-numeric price string", threwOnNaN);

// ── mapTimezoneToCurrency: best-effort heuristic ──
check("Asia/Manila -> php", mapTimezoneToCurrency("Asia/Manila") === "php");
check("Australia/Sydney -> aud", mapTimezoneToCurrency("Australia/Sydney") === "aud");
check("Australia/Perth -> aud (any Australia/* zone)", mapTimezoneToCurrency("Australia/Perth") === "aud");
check("America/New_York -> null (unmapped, falls through)", mapTimezoneToCurrency("America/New_York") === null);
check("null timezone -> null", mapTimezoneToCurrency(null) === null);
check(
  "garbage (not a real IANA zone) -> null, never trusted",
  mapTimezoneToCurrency("Not/A_Real_Zone") === null,
);

// ── resolveCurrencyPure: candidate wins when supported ──
const r1 = resolveCurrencyPure({
  candidate: "php",
  supported: new Set(["php", "usd"]),
  platformDefault: "usd",
  providerId: "paymongo",
});
check("resolveCurrencyPure: supported candidate used directly", r1.currency === "php" && !r1.usedFallback);

// ── resolveCurrencyPure: unsupported candidate falls back to platform default ──
const r2 = resolveCurrencyPure({
  candidate: "aud",
  supported: new Set(["php"]),
  platformDefault: "php",
  providerId: "paymongo",
});
check(
  "resolveCurrencyPure: PayMongo-only deployment, AUD-resolved tenant falls back to PHP (not USD)",
  r2.currency === "php" && r2.usedFallback,
);

// ── resolveCurrencyPure: platform default itself unsupported -> falls to usd ──
const r3 = resolveCurrencyPure({
  candidate: "aud",
  supported: new Set(["usd", "php"]),
  platformDefault: "eur", // not priced at all
  providerId: "stripe",
});
check(
  "resolveCurrencyPure: unsupported platform default skipped, falls to usd",
  r3.currency === "usd" && r3.usedFallback,
);

// ── resolveCurrencyPure: currency casing is normalized before comparison ──
const r4 = resolveCurrencyPure({
  candidate: "PHP",
  supported: new Set(["php"]),
  platformDefault: "USD", // registry default is literally uppercase "USD"
  providerId: "paymongo",
});
check(
  "resolveCurrencyPure: uppercase candidate normalized and matched (not silently falling through)",
  r4.currency === "php" && !r4.usedFallback,
);

// ── resolveCurrencyPure: empty supported set -> hard refuse, never a guess ──
let threwOnEmpty = false;
try {
  resolveCurrencyPure({
    candidate: "aud",
    supported: new Set(),
    platformDefault: "usd",
    providerId: "paymongo",
  });
} catch {
  threwOnEmpty = true;
}
check(
  "resolveCurrencyPure: empty supported set hard-refuses rather than guessing",
  threwOnEmpty,
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("BILLING-PRICING TESTS: FAIL ❌");
  process.exit(1);
}
console.log("BILLING-PRICING TESTS: PASS ✅");
