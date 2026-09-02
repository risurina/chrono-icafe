import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
const SEEDED_PASSWORD = "Password123!";

async function findInviteLink(toEmail: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  const pattern = new RegExp(
    `\\[email:console\\] to=${toEmail.replace(/[.+]/g, "\\$&")}.*?link=(\\S+)`,
  );
  while (Date.now() < deadline) {
    const log = readFileSync(DEV_LOG_PATH, "utf8");
    const match = log.match(pattern);
    if (match?.[1]) return match[1];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`,
  );
}

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
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

test.describe("Promos", () => {
  test("happy path: create, pause, and archive", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2epromos${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    await page.goto(`${base}/dashboard/promos`);
    await page.waitForLoadState("networkidle");

    // Create a promo
    await page.getByRole("button", { name: "New Promo" }).click();

    const promoName = faker.commerce.productName();
    await page.getByLabel("Name").fill(promoName);

    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const endsAtString = nextMonth.toISOString().slice(0, 16);
    await page.getByLabel("Ends At").fill(endsAtString);

    await page.getByLabel("Discount Value").fill("15.00");

    await page.getByRole("button", { name: "Create" }).click();

    // Confirm it appears active
    await expect(page.getByText(promoName)).toBeVisible();
    await expect(page.getByText("active", { exact: true })).toBeVisible();

    // Pause it
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("paused", { exact: true })).toBeVisible();

    // Archive it
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("archived", { exact: true })).toBeVisible();

    // Confirm archive is terminal (buttons disappear)
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);

    // Try to reactivate via API to ensure it fails
    const res = await page.request.get(`${base}/api/rpc/promos`);
    const body = (await res.json()) as { items: { id: string; name: string }[] };
    const promo = body.items.find((p) => p.name === promoName)!;

    const statusRes = await page.request.post(`${base}/api/rpc/promos/${promo.id}/status`, {
      data: { status: "active" }
    });
    expect(statusRes.status()).toBe(409);
  });

  test("role gate: staff cannot manage promos, admin/owner can", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2epromogate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2epromogateinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner setup
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // Owner creates a promo
    await page.goto(`${base}/dashboard/promos`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Promo" }).click();
    const promoName = faker.commerce.productName();
    await page.getByLabel("Name").fill(promoName);
    const endsAtString = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 16);
    await page.getByLabel("Ends At").fill(endsAtString);
    await page.getByLabel("Discount Value").fill("10.00");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(promoName)).toBeVisible();

    // Invite staff
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Login as staff
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Staff checks promos
    await page.goto(`${base}/dashboard/promos`);
    await page.waitForLoadState("networkidle");

    // Verify promo is visible but controls are hidden
    await expect(page.getByText(promoName)).toBeVisible();
    await expect(page.getByRole("button", { name: "New Promo" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);

    // Verify 403 via API directly for good measure
    const res = await page.request.get(`${base}/api/rpc/promos`);
    const body = (await res.json()) as { items: { id: string; name: string }[] };
    const promo = body.items.find((p) => p.name === promoName)!;

    const patchRes = await page.request.patch(`${base}/api/rpc/promos/${promo.id}`, {
      data: { name: "Hacked" }
    });
    expect(patchRes.status()).toBe(403);
  });

  test("tenant isolation: tenant A's promo not visible to tenant B, and direct API 404s", async ({ page, browser }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2epromoa${uniq}`;
    const slugB = `e2epromob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const promoName = "Isolation Promo";

    // Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // Tenant A creates promo
    await page.goto(`${baseA}/dashboard/promos`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Promo" }).click();
    await page.getByLabel("Name").fill(promoName);
    const endsAtString = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 16);
    await page.getByLabel("Ends At").fill(endsAtString);
    await page.getByLabel("Discount Value").fill("10.00");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(promoName)).toBeVisible();

    const resA = await page.request.get(`${baseA}/api/rpc/promos`);
    const bodyA = (await resA.json()) as { items: { id: string; name: string }[] };
    const promoId = bodyA.items.find((p) => p.name === promoName)!.id;

    // Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Verify Tenant B doesn't see Tenant A's promo
    await pageB.goto(`${baseB}/dashboard/promos`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(promoName)).toHaveCount(0);

    // Try direct GET
    const crossResGet = await pageB.request.get(`${baseB}/api/rpc/promos/${promoId}`);
    expect(crossResGet.status()).toBe(404);

    // Try direct PATCH
    const crossResPatch = await pageB.request.patch(`${baseB}/api/rpc/promos/${promoId}`, {
      data: { name: "Hacked" }
    });
    expect(crossResPatch.status()).toBe(404);

    await ctxB.close();
  });
});
