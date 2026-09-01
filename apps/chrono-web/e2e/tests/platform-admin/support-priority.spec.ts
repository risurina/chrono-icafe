import { test, expect } from "@playwright/test";

const SEEDED_PASSWORD = "Password123!";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

test.describe("Platform Support Ticket Priority", () => {
  test("an admin creates a ticket then changes its priority and it persists", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    const orgs = await page.request.get(`${API}/rpc-admin/organizations?q=acme`, { headers: { "x-platform-admin": "1" } });
    const items = (await orgs.json()).items;
    const orgId = (items.find((o: any) => o.slug === "acme") ?? items[0]).id;
    expect(orgId).toBeTruthy();

    const created = await page.request.post(`${API}/rpc-admin/support-tickets`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { organizationId: orgId, subject: `Priority test ${Date.now()}`, body: "seed" }
    });
    expect(created.ok()).toBeTruthy();
    const ticket = await created.json();
    expect(ticket.priority).toBe("normal");

    const patched = await page.request.patch(`${API}/rpc-admin/support-tickets/${ticket.id}`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { priority: "high" }
    });
    expect(patched.ok()).toBeTruthy();
    expect((await patched.json()).priority).toBe("high");

    const detail = await page.request.get(`${API}/rpc-admin/support-tickets/${ticket.id}`, {
      headers: { "x-platform-admin": "1" }
    });
    expect((await detail.json()).priority).toBe("high");
  });

  test("a non-manage actor cannot change a ticket's priority (manage gate)", async ({ page }) => {
    // Use a tenant owner with NO platform role as the drift-proof non-manage
    // actor. (The `support` platform role legitimately holds supportTicket:manage,
    // so it is not a valid subject for this gate.) The permission check fires
    // before the id lookup, so a bogus id returns 403, not 404.
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const res = await page.request.patch(`${API}/rpc-admin/support-tickets/bogus-id-xyz`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { priority: "high" }
    });
    expect(res.status()).toBe(403);
  });

  test("changing priority without the CSRF header is rejected", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    const res = await page.request.patch(`${API}/rpc-admin/support-tickets/bogus-id-xyz`, {
      headers: { "content-type": "application/json" },
      data: { priority: "high" }
    });
    expect(res.status()).toBe(400);
  });
});
