import { test, expect } from "@playwright/test";

const SEEDED_PASSWORD = "Password123!";

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

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

test.describe("Platform Custom Roles — edit", () => {
  let activeKey: string | null = null;

  test.afterEach(async ({ page }) => {
    if (activeKey) {
      try {
        await signInStaff(page, "localtest.me:3000", "platform@agora.test");
        await page.request.delete(`${API}/rpc-admin/staff/roles/${activeKey}`, {
          headers: { "x-platform-admin": "1" },
        });
      } catch (e) {
        // best effort ignore
      }
      activeKey = null;
    }
  });

  // Note: the "cannot grant a permission you do not hold" guard is only trippable by a non-admin staff:manage holder and is covered in apps/api/src/e2e/permissions.test.ts, not here.

  test("an admin creates, edits, and deletes a custom role", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    const KEY = `e2e-edit-${Date.now()}`;
    activeKey = KEY;

    const created = await page.request.post(`${API}/rpc-admin/staff/roles`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { key: KEY, name: "E2E Editable", description: "before", permission: { organization: ["read"] } },
    });
    expect(created.ok()).toBeTruthy();

    const edited = await page.request.patch(`${API}/rpc-admin/staff/roles/${KEY}`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { name: "E2E Editable v2", description: "after", permission: { organization: ["read"], audit: ["read"] } },
    });
    expect(edited.ok()).toBeTruthy();

    const body = await edited.json();
    expect(body.name).toBe("E2E Editable v2");
    expect(body.permission).toEqual({ organization: ["read"], audit: ["read"] });

    const list = await page.request.get(`${API}/rpc-admin/staff/roles`, {
      headers: { "x-platform-admin": "1" },
    });
    const found = (await list.json()).items.find((r: any) => r.key === KEY);
    expect(found?.name).toBe("E2E Editable v2");

    const del = await page.request.delete(`${API}/rpc-admin/staff/roles/${KEY}`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(del.ok()).toBeTruthy();
  });

  test("a viewer cannot create a custom role (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const res = await page.request.post(`${API}/rpc-admin/staff/roles`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { key: `e2e-v-${Date.now()}`, name: "nope", permission: {} },
    });
    expect(res.status()).toBe(403);
  });

  test("a viewer cannot edit a custom role (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const res = await page.request.patch(`${API}/rpc-admin/staff/roles/does-not-exist`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { name: "nope" },
    });
    expect(res.status()).toBe(403);
  });
});
