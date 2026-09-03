import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Phase 6 (tenant isolation) of .ai/plans/chrono/active/reconciliation/README.md.
 *
 * Tenant B must never read tenant A's shift breakdown — a direct cross-tenant
 * id lookup 404s (the reconciliation read route scopes its query by
 * `c.var.tenant.tenantId` under `withTenant`/RLS, not by the shift id alone).
 * Because ids are `createId()`-generated, tenant A's and B's shifts can never
 * actually collide on id — the isolation guarantee here is RLS + `withTenant`,
 * not id randomness, so this only needs to prove the cross-tenant read is
 * refused, not race two shifts onto the same id.
 */
const SEEDED_PASSWORD = "Password123!";

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function createBranch(page: import("@playwright/test").Page, base: string, name: string) {
  const res = await page.request.post(`${base}/api/rpc/branches`, {
    data: { name, code: name.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X"), status: "active" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { branch: { id: string } };
  return body.branch.id;
}

async function openShift(
  page: import("@playwright/test").Page,
  base: string,
  branchId: string,
  openingCashAmount: string,
) {
  const res = await page.request.post(`${base}/api/rpc/shifts/open`, {
    data: { branchId, openingCashAmount },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { shift: { id: string } };
  return body.shift.id;
}

test.describe("Reconciliation — tenant isolation", () => {
  test("tenant B cannot read tenant A's shift breakdown; direct cross-tenant id lookup 404s", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2ereconisoa${uniq}`;
    const slugB = `e2ereconisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    const branchIdA = await createBranch(page, baseA, `Branch A ${uniq}`);
    const shiftIdA = await openShift(page, baseA, branchIdA, "60.00");
    const closeResA = await page.request.post(`${baseA}/api/rpc/shifts/${shiftIdA}/close`, {
      data: { actualCashAmount: "55.00" },
    });
    expect(closeResA.ok()).toBeTruthy();

    // Tenant A can read its own shift's breakdown.
    const ownReadRes = await page.request.get(`${baseA}/api/rpc/reconciliation/shifts/${shiftIdA}`);
    expect(ownReadRes.ok()).toBeTruthy();
    const ownReadBody = (await ownReadRes.json()) as {
      summary: { expectedCashAmount: string | null; differenceAmount: string | null };
    };
    expect(ownReadBody.summary.expectedCashAmount).toBe("60.00");
    expect(ownReadBody.summary.differenceAmount).toBe("-5.00");

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Tenant B's own dashboard never shows tenant A's shift.
    await pageB.goto(`${baseB}/dashboard/reconciliation`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText("-5.00")).toHaveCount(0);

    // Direct cross-tenant read attempt 404s, never leaking or succeeding.
    const crossReadRes = await pageB.request.get(`${baseB}/api/rpc/reconciliation/shifts/${shiftIdA}`);
    expect(crossReadRes.status()).toBe(404);

    await ctxB.close();
  });
});
