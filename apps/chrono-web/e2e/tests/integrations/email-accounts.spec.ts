import { test, expect } from "@playwright/test";

const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
// Must share the `.localtest.me` cookie domain the staff session is scoped to
// (see cookieDomain() in agora/auth) — "localhost:8787" would silently drop
// the session cookie on every page.request call in this spec.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localtest.me:8787";

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
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

async function revokeRole(page: import("@playwright/test").Page, email: string) {
  const staffRes = await page.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  const staffBody = (await staffRes.json()) as {
    items: { userId: string; email: string }[];
  };
  const target = staffBody.items.find((i) => i.email === email);
  if (target) {
    await page.request.patch(`${API_URL}/rpc-admin/staff/${target.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: null },
    });
  }
}

test.describe("Platform Email Accounts Integration", () => {
  test.afterEach(async ({ page }) => {
    // Clear out any added accounts
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const res = await page.request.get(`${API_URL}/rpc-admin/integrations/email/accounts`, {
      headers: { "x-platform-admin": "1" },
    });
    const body = (await res.json()) as { accounts: { id: string }[] };
    for (const acc of body.accounts || []) {
      await page.request.delete(`${API_URL}/rpc-admin/integrations/email/accounts/${acc.id}`, {
        headers: { "x-platform-admin": "1" },
      });
    }
    // Revert role for throwaway viewer
    await revokeRole(page, "owner@acme.test");
  });

  test("a platform admin can add, edit, test, and delete an email account", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/integrations/email");
    await page.waitForLoadState("networkidle");

    // Add account
    await page.getByRole("button", { name: "Add account" }).click();
    await page.getByLabel(/Provider/).click();
    await page.getByRole("option", { name: "Resend" }).click();
    await page.getByLabel(/Label/).fill("Primary Resend");
    await page.getByLabel(/Priority/).fill("1");
    await page.getByLabel(/Secret/).fill("re_test123");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Primary Resend")).toBeVisible();
    await expect(page.getByText("resend", { exact: true }).first()).toBeVisible();

    // Test connection
    const testBtn = page.getByRole("button", { name: "Test" }).first();
    await testBtn.click();
    await expect(page.getByText(/Tested connection|Credentials decrypted successfully/i)).toBeVisible();

    // Edit account
    const editBtn = page.getByRole("button", { name: "Edit" }).first();
    await editBtn.click();
    await page.getByLabel(/Label/).fill("Primary Resend Updated");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Primary Resend Updated")).toBeVisible();

    // Delete account
    const deleteBtn = page.getByRole("button", { name: "Delete" }).first();
    await deleteBtn.click();
    await expect(page.getByText("Primary Resend Updated")).toHaveCount(0);
  });

  test("a platform viewer sees read-only view and cannot mutate via API", async ({
    page,
    browser,
  }) => {
    // Grant owner@acme.test the viewer platform role
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const staffRes = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
      headers: { "x-platform-admin": "1" },
    });
    const staffBody = (await staffRes.json()) as {
      items: { userId: string; email: string }[];
    };
    let target = staffBody.items.find((i) => i.email === "owner@acme.test");
    if (!target) {
      const acmeOrgRes = await adminPage.request.get(
        `${API_URL}/rpc-admin/organizations?q=acme`,
        { headers: { "x-platform-admin": "1" } },
      );
      const acmeOrg = (await acmeOrgRes.json()) as { items: { id: string }[] };
      const membersRes = await adminPage.request.get(
        `${API_URL}/rpc-admin/organizations/${acmeOrg.items[0]!.id}/members`,
        { headers: { "x-platform-admin": "1" } },
      );
      const members = (await membersRes.json()) as {
        items: { userId: string; email: string }[];
      };
      target = members.items.find((m) => m.email === "owner@acme.test");
    }
    expect(target).toBeTruthy();
    await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${target!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    await adminCtx.close();

    // Sign in as viewer
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    await page.goto("http://localtest.me:3000/admin/integrations/email");
    await page.waitForLoadState("networkidle");

    // UI controls should be hidden
    await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // API should 403
    const createRes = await page.request.post(`${API_URL}/rpc-admin/integrations/email/accounts`, {
      headers: { "x-platform-admin": "1" },
      data: { provider: "resend", label: "Hacked", priority: 1, config: {}, enabled: true },
    });
    expect(createRes.status()).toBe(403);
  });
});
