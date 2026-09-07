import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * `/stations` after the white-label rebuild: tenant chrome instead of a generic
 * header, and FOUR honest status buckets instead of the conflated
 * "In Use / Offline" one.
 *
 * That old label sat over a number the API computed as `maintenance + offline`,
 * so a machine under maintenance was advertised as in use and a genuinely
 * occupied one was counted nowhere. The counts asserted below are derived from
 * the station rows themselves, so a regression to the conflated bucket fails.
 *
 * `availability.spec.ts` still owns this route's own data/isolation coverage;
 * this spec covers presentation and the never-dead-end empty state.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<string> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();

  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
}

/**
 * The value shown under one of the five summary cards.
 *
 * Addressed by testid, not by structure: the label sits in a `CardTitle`
 * (`h3`) and the value in a sibling `CardContent`, and the same status words
 * reappear on every station badge further down the page — so any
 * label-relative or class-based locator resolves to the wrong node or none.
 */
function summaryValue(page: import("@playwright/test").Page, label: string) {
  return page.getByTestId(
    `stations-summary-${label.toLowerCase().replace(/\s+/g, "-")}`,
  );
}

test.describe("Public stations — tenant-branded availability", () => {
  test("shows tenant chrome, four honest status buckets, and both CTAs", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrandedstations${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `test-branch-${uniq}`;

    await signUp(page, { name: slug, email, slug });
    const branchId = await createBranch(page, base, branchName);

    // Two available, one maintenance, one offline — so "Maintenance" and
    // "Offline" hold DIFFERENT numbers and a conflated bucket cannot satisfy
    // both assertions at once.
    for (const station of [
      { name: "PC-01", stationNumber: "01", stationType: "pc", status: "available" },
      { name: "PC-02", stationNumber: "02", stationType: "pc", status: "available" },
      { name: "PC-03", stationNumber: "03", stationType: "pc", status: "maintenance" },
      { name: "PC-04", stationNumber: "04", stationType: "pc", status: "offline" },
    ]) {
      const created = await page.request.post(`${API_URL}/rpc/stations`, {
        data: { branchId, ...station },
      });
      expect(created.ok()).toBeTruthy();
    }

    // Public surface — no session.
    await page.context().clearCookies();
    await page.goto(`${base}/stations`);
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain(`${base}/stations`);

    // Tenant chrome, not a generic "Station Availability" heading.
    await expect(page.getByText(`${slug} — Live PC availability`)).toBeVisible();
    await expect(page.getByText("Station Availability", { exact: true })).toHaveCount(0);

    // Four real states. The conflated bucket must be gone.
    await expect(page.getByText("In Use / Offline")).toHaveCount(0);
    await expect(summaryValue(page, "Total stations")).toHaveText("4");
    await expect(summaryValue(page, "Available")).toHaveText("2");
    await expect(summaryValue(page, "In use")).toHaveText("0");
    await expect(summaryValue(page, "Maintenance")).toHaveText("1");
    await expect(summaryValue(page, "Offline")).toHaveText("1");

    // The per-station badges tell the same story as the summary.
    const pc03 = page.locator(".overflow-hidden").filter({ hasText: "PC-03" });
    await expect(pc03.getByText("Maintenance")).toBeVisible();
    const pc04 = page.locator(".overflow-hidden").filter({ hasText: "PC-04" });
    await expect(pc04.getByText("Offline")).toBeVisible();

    // Never a dead end, and always a way back to the venue's own site.
    const join = page.getByTestId("stations-join-cta");
    await expect(join.first()).toBeVisible();
    await expect(join.first()).toHaveText(`Join ${slug}`);
    await expect(join.first()).toHaveAttribute("href", "/member/sign-up");
    const back = page.getByTestId("stations-back-home");
    await expect(back.first()).toBeVisible();
    await expect(back.first()).toHaveText(`Back to ${slug}`);
    await expect(back.first()).toHaveAttribute("href", "/");

    // Same branded footer as every other public tenant surface.
    await expect(page.getByText("Powered by Chrono")).toBeVisible();
    await expect(page.getByTestId("tenant-footer-partner-link")).toBeVisible();
  });

  test("a tenant with no stations still offers a way in, not a dead end", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eemptystations${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    // Signed up, no branch and no stations — the brand-new-tenant case.
    await signUp(page, { name: slug, email, slug });
    await page.context().clearCookies();

    await page.goto(`${base}/stations`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(`No stations listed for ${slug} yet.`)).toBeVisible();
    await expect(page.getByTestId("stations-join-cta")).toBeVisible();
    await expect(page.getByTestId("stations-back-home")).toBeVisible();
  });

  test("an unresolvable subdomain 404s at /stations", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const res = await page.goto(`http://e2enostations${uniq}.localtest.me:3000/stations`);
    expect(res?.status()).toBe(404);
  });
});
