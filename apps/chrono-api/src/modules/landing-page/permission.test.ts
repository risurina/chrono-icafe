/**
 * Permission-gate check for landing-page settings editor (tenant-landing
 * Phase 3, `.ai/plans/chrono/active/tenant-landing/README.md` — Acceptance
 * Criteria: PATCH 403s for staff, 200s for admin/owner).
 *
 * Pure permission-resolution check (no DB/HTTP needed) — mirrors the shape
 * of `apps/chrono-api/src/e2e/permissions.test.ts`'s per-resource assertions.
 */
import "dotenv/config";
import "../../auth-bootstrap";
import { hasPermission } from "../../auth/require-permission";

let failed = false;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  console.log(`${ok ? "✅" : "❌"} ${label}: expected ${expected}, got ${actual}`);
  if (!ok) failed = true;
}

check("staff cannot manage landingPage", hasPermission("staff", { landingPage: ["manage"] }), false);
check("admin can manage landingPage", hasPermission("admin", { landingPage: ["manage"] }), true);
check("owner can manage landingPage", hasPermission("owner", { landingPage: ["manage"] }), true);

if (failed) {
  console.error("FAILED");
  process.exit(1);
}
console.log("PASS ✅");
