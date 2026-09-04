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
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform User Mutations", () => {
  const host = "localtest.me:3000";
  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

  test("viewer denied all five mutations", async ({ page }) => {
    await signInStaff(page, host, "platform-viewer@agora.test");

    const patchRes = await page.request.patch(`${API}/rpc-admin/users/does-not-exist`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { name: "Gate Test" },
    });
    expect(patchRes.status()).toBe(403);

    const assignRoleRes = await page.request.post(`${API}/rpc-admin/users/does-not-exist/assign-role`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { organizationId: "org-x", role: "admin" },
    });
    expect(assignRoleRes.status()).toBe(403);

    const moveTenantRes = await page.request.post(`${API}/rpc-admin/users/does-not-exist/move-tenant`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { fromOrganizationId: "org-a", toOrganizationId: "org-b", role: "admin" },
    });
    expect(moveTenantRes.status()).toBe(403);

    const revokeSessionsRes = await page.request.post(`${API}/rpc-admin/users/does-not-exist/revoke-sessions`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(revokeSessionsRes.status()).toBe(403);

    const deleteRes = await page.request.delete(`${API}/rpc-admin/users/does-not-exist`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(deleteRes.status()).toBe(403);
  });

  test("tenant owner (no platform role) denied all five mutations", async ({ page }) => {
    await signInStaff(page, host, "owner@acme.test");

    const patchRes = await page.request.patch(`${API}/rpc-admin/users/does-not-exist`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { name: "Gate Test" },
    });
    expect(patchRes.status()).toBe(403);

    const assignRoleRes = await page.request.post(`${API}/rpc-admin/users/does-not-exist/assign-role`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { organizationId: "org-x", role: "admin" },
    });
    expect(assignRoleRes.status()).toBe(403);

    const moveTenantRes = await page.request.post(`${API}/rpc-admin/users/does-not-exist/move-tenant`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { fromOrganizationId: "org-a", toOrganizationId: "org-b", role: "admin" },
    });
    expect(moveTenantRes.status()).toBe(403);

    const revokeSessionsRes = await page.request.post(`${API}/rpc-admin/users/does-not-exist/revoke-sessions`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(revokeSessionsRes.status()).toBe(403);

    const deleteRes = await page.request.delete(`${API}/rpc-admin/users/does-not-exist`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(deleteRes.status()).toBe(403);
  });

  test("admin edits a user's name and reverts it", async ({ page }) => {
    await signInStaff(page, host, "platform@agora.test");

    const list = await page.request.get(`${API}/rpc-admin/users?q=owner@globex.test`, {
      headers: { "x-platform-admin": "1" }
    });
    expect(list.status()).toBe(200);

    const id = (await list.json()).items[0].id;

    const up = await page.request.patch(`${API}/rpc-admin/users/${id}`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { name: "QA Temp Name" }
    });
    expect(up.ok()).toBeTruthy();

    const back = await page.request.patch(`${API}/rpc-admin/users/${id}`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { name: "Globex Owner" }
    });
    expect(back.ok()).toBeTruthy();
  });
});
