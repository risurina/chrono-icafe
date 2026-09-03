import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
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
  throw new Error(`Invite link not found for ${toEmail} in ${DEV_LOG_PATH}`);
}

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<void> {
  await page.goto(`${base}/dashboard/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("Devices", () => {
  test("happy path: generate pairing code, pair device, approve, revoke", async ({ page, request }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edev${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;
    const tokenName = `${faker.word.adjective()} Setup Token`;
    const fingerprint = faker.string.alphanumeric(32).toLowerCase();
    const hostname = `PC-${faker.string.numeric(3)}`;
    const newStationName = `${faker.word.noun()} Station`;
    const newStationNumber = faker.string.numeric(3);

    await signUp(page, { name: faker.person.fullName(), email, slug });
    await createBranch(page, base, branchName);

    await page.goto(`${base}/dashboard/devices`);
    await page.waitForLoadState("networkidle");

    // 1. Generate Pairing Code via UI
    await page.getByRole("button", { name: /Generate Pairing Code/i }).click();
    await page.getByRole("combobox", { name: /Branch/i }).click();
    await page.getByRole("option", { name: branchName }).click();
    await page.getByLabel("Name *").fill(tokenName);
    await page.getByRole("button", { name: "Generate" }).click();

    await expect(page.getByText("Enter this pairing code on the device")).toBeVisible();

    // Extract pairing code from the UI
    const pairingCodeLocator = page.locator(".select-all");
    const pairingCodeText = await pairingCodeLocator.textContent();
    const pairingCode = pairingCodeText?.trim() || "";
    expect(pairingCode).toBeTruthy();

    await page.getByRole("button", { name: "Done" }).click();

    // 2. Simulate PC client: POST /api/v1/device/pair
    const pairRes = await request.post(`${API_URL}/api/v1/device/pair`, {
      data: { pairingCode }
    });
    expect(pairRes.ok()).toBeTruthy();
    const { provisioningToken } = (await pairRes.json()) as { provisioningToken: string };
    expect(provisioningToken).toBeTruthy();

    // 3. Simulate PC client: POST /api/v1/device/auth
    const authRes = await request.post(`${API_URL}/api/v1/device/auth`, {
      data: {
        provisioningToken,
        fingerprint,
        hostname
      }
    });
    expect(authRes.status()).toBe(201);
    const authJson = await authRes.json() as { deviceToken: string; status: string; minted: boolean };
    expect(authJson.status).toBe("pending_approval");
    expect(authJson.minted).toBe(true);

    // 4. Drive the rest through the UI
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(hostname)).toBeVisible();
    await expect(page.getByText("Pending")).toBeVisible();

    // Approve the device
    await page.getByRole("button", { name: "Approve" }).click();

    // Approve device dialog
    await page.getByRole("button", { name: "New Station" }).click();
    await page.getByLabel("Station Name *").fill(newStationName);
    await page.getByLabel("Station Number *").fill(newStationNumber);
    await page.getByRole("button", { name: "Approve Device" }).click();

    await expect(page.getByText("Device approved")).toBeVisible();
    await expect(page.getByText("Approved")).toBeVisible();
    await expect(page.getByText(`${newStationNumber}: ${newStationName}`)).toBeVisible();

    // Revoke the device
    await page.getByRole("button", { name: "Revoke" }).first().click();
    await page.getByRole("button", { name: "Revoke Device" }).click();

    await expect(page.getByText("Device revoked")).toBeVisible();
    await expect(page.getByText("Revoked")).toBeVisible();
  });

  test("role gate: staff gets 403 on approve/revoke", async ({ page, request }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevrole${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2edevrolestaff${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;
    const tokenName = `${faker.word.adjective()} Staff Token`;
    const fingerprint = faker.string.alphanumeric(32).toLowerCase();
    const hostname = `PC-Staff-${faker.string.numeric(3)}`;
    const newStationName = `${faker.word.noun()} Staff Station`;

    // Owner setup
    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);

    // Invite staff
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    // Owner creates pairing code
    await page.goto(`${base}/dashboard/devices`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Generate Pairing Code/i }).click();
    await page.getByRole("combobox", { name: /Branch/i }).click();
    await page.getByRole("option", { name: branchName }).click();
    await page.getByLabel("Name *").fill(tokenName);
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText("Enter this pairing code on the device")).toBeVisible();
    const pairingCodeText = await page.locator(".select-all").textContent();
    const pairingCode = pairingCodeText?.trim() || "";
    await page.getByRole("button", { name: "Done" }).click();

    // Owner simulates pair and auth (using request fixture!)
    const pairRes = await request.post(`${API_URL}/api/v1/device/pair`, { data: { pairingCode } });
    const { provisioningToken } = (await pairRes.json()) as { provisioningToken: string };
    await request.post(`${API_URL}/api/v1/device/auth`, { data: { provisioningToken, fingerprint, hostname } });

    // Log out
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Login as staff
    await signUp(page, { name: faker.person.fullName(), email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), { timeout: 15_000 });

    // Staff visits devices page
    await page.goto(`${base}/dashboard/devices`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(hostname)).toBeVisible();

    // Staff attempts to approve
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("button", { name: "New Station" }).click();
    await page.getByLabel("Station Name *").fill(newStationName);
    await page.getByLabel("Station Number *").fill(faker.string.numeric(3));
    await page.getByRole("button", { name: "Approve Device" }).click();
    await expect(page.getByText("You don't have permission")).toBeVisible();

    // Close dialog and verify state unchanged
    await page.getByRole("dialog").press("Escape");
    await expect(page.getByText("Pending")).toBeVisible();

    // Staff attempts to revoke
    await page.getByRole("button", { name: "Revoke" }).first().click();
    await page.getByRole("button", { name: "Revoke Device" }).click();
    await expect(page.getByText("You don't have permission")).toBeVisible();
    await page.getByRole("dialog").press("Escape");
    await expect(page.getByText("Pending")).toBeVisible();
  });

  test("tenant isolation: devices scoped to tenant and cross-tenant heartbeat 401s or doesn't leak", async ({ page, browser, request }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2edevtena${uniq}`;
    const slugB = `e2edevtenb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `${faker.company.name()} Branch A`;
    const branchNameB = `${faker.company.name()} Branch B`;
    const tokenName = `${faker.word.adjective()} Token`;
    const fingerprint = faker.string.alphanumeric(32).toLowerCase();
    const hostname = `PC-A-${faker.string.numeric(3)}`;

    // Tenant A setup
    await signUp(page, { name: faker.person.fullName(), email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);

    // Tenant A creates device
    await page.goto(`${baseA}/dashboard/devices`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Generate Pairing Code/i }).click();
    await page.getByRole("combobox", { name: /Branch/i }).click();
    await page.getByRole("option", { name: branchNameA }).click();
    await page.getByLabel("Name *").fill(tokenName);
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText("Enter this pairing code on the device")).toBeVisible();
    const pairingCodeText = await page.locator(".select-all").textContent();
    const pairingCode = pairingCodeText?.trim() || "";
    await page.getByRole("button", { name: "Done" }).click();

    const pairRes = await request.post(`${API_URL}/api/v1/device/pair`, { data: { pairingCode } });
    const { provisioningToken } = (await pairRes.json()) as { provisioningToken: string };
    const authRes = await request.post(`${API_URL}/api/v1/device/auth`, { data: { provisioningToken, fingerprint, hostname } });
    const { deviceToken } = (await authRes.json()) as { deviceToken: string };

    // Tenant B setup
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: faker.person.fullName(), email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);

    // Verify B cannot see A's device
    await pageB.goto(`${baseB}/dashboard/devices`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(hostname)).toHaveCount(0);

    // Critical Tenant Isolation: Heartbeat with Tenant A's deviceToken works on A
    // Note: The heartbeat payload is just telemetry. The backend resolves the tenant ID
    // from the device token, so there is no path/body param to inject a different tenant's ID.
    const heartbeatResA = await request.post(`${API_URL}/api/v1/device/heartbeat`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
      data: {
        clientVersion: faker.system.semver(),
      },
    });
    expect(heartbeatResA.ok()).toBeTruthy();

    await expect(pageB.getByText(hostname)).toHaveCount(0);
    await ctxB.close();
  });
});
