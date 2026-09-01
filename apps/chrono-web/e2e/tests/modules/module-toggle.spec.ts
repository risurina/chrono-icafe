import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the module registry (`modules.project`, see
 * packages/agora/src/contracts/module-registry.ts): disabling the backing
 * feature flag for one tenant hides its "Projects" nav entry, while another
 * tenant with the flag left on is unaffected. The toggle itself reuses the
 * existing `PUT /rpc-admin/organizations/:id/feature-flags` route — this
 * spec only proves the nav-gating layer on top, same conventions as
 * `platform-admin/feature-flags.spec.ts`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const FLAG_KEY = "modules.project";
const FLAG_LABEL = "Projects module";

async function signUpWorkspace(
  page: import("@playwright/test").Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function signInStaff(
  page: import("@playwright/test").Page,
  host: string,
  email: string,
) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

async function findOrgId(
  page: import("@playwright/test").Page,
  slug: string,
): Promise<string> {
  const res = await page.request.get(
    `${API_URL}/rpc-admin/organizations?q=${slug}`,
    { headers: { "x-platform-admin": "1" } },
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string }[] };
  const id = body.items[0]?.id;
  expect(id).toBeTruthy();
  return id!;
}

test.describe("Module registry — nav gating", () => {
  test("disabling modules.project for one tenant hides its Projects nav entry; another tenant is unaffected", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const uniq = Date.now();
    const slugA = `test-mod-a${uniq}`;
    const slugB = `test-mod-b${uniq}`;
    const ownerAEmail = `test-mod-owner-a${uniq}@example.com`;
    const ownerBEmail = `test-mod-owner-b${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Mod Owner A", email: ownerAEmail, slug: slugA });
    const ownerBContext = await browser.newContext();
    const ownerBPage = await ownerBContext.newPage();
    await signUpWorkspace(ownerBPage, { name: "Mod Owner B", email: ownerBEmail, slug: slugB });

    // Registry default is enabled — both tenants see the nav entry before any toggle.
    await page.goto(`http://${slugA}.localtest.me:3000/dashboard`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgAId = await findOrgId(adminPage, slugA);

    // Disable modules.project for tenant A only, via the existing admin toggle.
    await adminPage.goto(`http://localtest.me:3000/admin/organizations/${orgAId}`);
    await adminPage.waitForLoadState("networkidle");
    const toggle = adminPage.getByRole("switch", { name: `Toggle ${FLAG_LABEL}` });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    // Tenant A's nav entry disappears.
    await page.goto(`http://${slugA}.localtest.me:3000/dashboard`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Projects" })).toHaveCount(0);

    // Tenant B is unaffected.
    await ownerBPage.goto(`http://${slugB}.localtest.me:3000/dashboard`);
    await ownerBPage.waitForLoadState("networkidle");
    await expect(ownerBPage.getByRole("link", { name: "Projects" })).toBeVisible();

    const orgBRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?q=${slugB}`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(orgBRes.ok()).toBeTruthy();
    const orgBId = (await orgBRes.json() as { items: { id: string }[] }).items[0]?.id;
    const orgBDetailRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgBId}`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(orgBDetailRes.ok()).toBeTruthy();
    const orgBDetail = (await orgBDetailRes.json()) as {
      featureFlags: { key: string; enabled: boolean }[];
    };
    expect(orgBDetail.featureFlags.find((f) => f.key === FLAG_KEY)?.enabled).toBe(true);

    await ownerBContext.close();
    await adminContext.close();
  });
});
