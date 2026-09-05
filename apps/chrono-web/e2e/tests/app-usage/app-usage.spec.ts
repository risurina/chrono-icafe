/**
 * Manual browser suite for the app-usage module (app-usage plan, Phase 5).
 * Requires `pnpm dev` already running (web :3000 + api :8787) — see
 * playwright.config.ts's own header comment.
 *
 * Copies the inline pair→auth→approve sequence from
 * `apps/chrono-web/e2e/tests/devices/devices.spec.ts` — there is no shared
 * device-minting helper today, so it's written inline per test here too.
 */
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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<void> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("App Usage", () => {
  test("happy path: launched then closed reflects in Currently Running and Usage Summary", async ({
    page,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eau${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;
    const tokenName = `${faker.word.adjective()} Kiosk Token`;
    const fingerprint = faker.string.alphanumeric(32).toLowerCase();
    const hostname = `PC-AU-${faker.string.numeric(3)}`;
    const stationName = `${faker.word.noun()} Station`;
    const stationNumber = faker.string.numeric(3);
    const appName = `E2E Game ${faker.string.alphanumeric(6)}`;

    await signUp(page, { name: faker.person.fullName(), email, slug });
    await createBranch(page, base, branchName);

    // Pair + approve a device with a station assigned.
    await page.goto(`${base}/admin/devices`);
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

    const pairRes = await request.post(`${API_URL}/api/v1/device/pair`, { data: { pairingCode } });
    const { provisioningToken } = (await pairRes.json()) as { provisioningToken: string };
    const authRes = await request.post(`${API_URL}/api/v1/device/auth`, {
      data: { provisioningToken, fingerprint, hostname },
    });
    const { deviceToken } = (await authRes.json()) as { deviceToken: string };

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("button", { name: "New Station" }).click();
    await page.getByLabel("Station Name *").fill(stationName);
    await page.getByLabel("Station Number *").fill(stationNumber);
    await page.getByRole("button", { name: "Approve Device" }).click();
    await expect(page.getByText("Device approved")).toBeVisible();

    // Post ONLY launched — the run is still open.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const launchRes = await request.post(`${API_URL}/api/v1/device/app-usage/events`, {
      headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Fingerprint": fingerprint },
      data: { launched: [{ runId: "e2e-happy-run", category: "game", appName, startedAt }], closed: [] },
    });
    expect(launchRes.ok()).toBeTruthy();

    // Currently Running shows it while still open.
    await page.goto(`${base}/admin/app-usage`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Currently Running" })).toBeVisible();
    await expect(page.getByText(appName)).toBeVisible();
    await expect(page.getByText(stationName)).toBeVisible();

    // Close it.
    const endedAt = new Date().toISOString();
    const closeRes = await request.post(`${API_URL}/api/v1/device/app-usage/events`, {
      headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Fingerprint": fingerprint },
      data: { launched: [], closed: [{ runId: "e2e-happy-run", endedAt }] },
    });
    expect(closeRes.ok()).toBeTruthy();

    // Usage Summary reflects the closed run's totals.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Usage Summary" })).toBeVisible();
    await expect(page.getByText(appName)).toBeVisible();
  });

  test("permission gate: a member with no appUsage:read gets 403 on all three GETs", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eaugate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2eaugatestaff${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);

    // Invite a staff member (role defaults to "staff" — reassigned below).
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    // appUsage:read is a single-tier gate — every system role (staff/admin/
    // owner) holds it, so there's no staff-vs-admin split to test here (see
    // the module plan's Phase 5, "No role-gate in the usual sense"). Create a
    // custom role granting NOTHING and assign it to the invited member — this
    // is the module's real gate.
    const roleRes = await page.request.post(`${API_URL}/rpc/roles`, {
      headers: { "x-tenant-slug": slug },
      data: { key: "no-app-usage", name: "No App Usage", permissions: {} },
    });
    expect(roleRes.ok()).toBeTruthy();

    const membersRes = await page.request.get(`${API_URL}/rpc/members?page=1&pageSize=50`, {
      headers: { "x-tenant-slug": slug },
    });
    const membersBody = (await membersRes.json()) as { items: { id: string; email: string }[] };
    const staffMemberId = membersBody.items.find((m) => m.email === staffEmail)?.id;
    expect(staffMemberId).toBeTruthy();
    const roleChangeRes = await page.request.patch(`${API_URL}/rpc/members/${staffMemberId}/role`, {
      headers: { "x-tenant-slug": slug },
      data: { role: "no-app-usage" },
    });
    expect(roleChangeRes.ok()).toBeTruthy();

    // Accept the invite as the staff member, in a separate browser context.
    const staffCtx = await browser.newContext();
    const staffPage = await staffCtx.newPage();
    await signUp(staffPage, { name: faker.person.fullName(), email: staffEmail, slug: staffSlug });
    await staffPage.goto(inviteLink);
    await expect(staffPage.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await staffPage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), { timeout: 15_000 });

    // Visibility only: the nav entry itself must not appear for this member
    // (<Can>-gated — the server route below is the real gate).
    await staffPage.goto(`${base}/admin`);
    await staffPage.waitForLoadState("networkidle");
    await expect(staffPage.getByRole("link", { name: "App Usage" })).toHaveCount(0);

    const from = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const to = encodeURIComponent(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    const currentDenied = await staffPage.request.get(
      `${API_URL}/rpc/app-usage/current?stationId=doesnotmatter`,
      { headers: { "x-tenant-slug": slug } },
    );
    expect(currentDenied.status()).toBe(403);
    const listDenied = await staffPage.request.get(`${API_URL}/rpc/app-usage?page=1&pageSize=10`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(listDenied.status()).toBe(403);
    const summaryDenied = await staffPage.request.get(
      `${API_URL}/rpc/app-usage/summary?from=${from}&to=${to}&page=1&pageSize=10`,
      { headers: { "x-tenant-slug": slug } },
    );
    expect(summaryDenied.status()).toBe(403);

    await staffCtx.close();
  });

  test("tenant isolation: tenant A's device-posted events never appear in tenant B's app-usage reads", async ({
    page,
    browser,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2eauisoa${uniq}`;
    const slugB = `e2eauisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `${faker.company.name()} Branch A`;
    const branchNameB = `${faker.company.name()} Branch B`;
    const tokenName = `${faker.word.adjective()} Token`;
    const fingerprint = faker.string.alphanumeric(32).toLowerCase();
    const hostname = `PC-ISO-${faker.string.numeric(3)}`;
    const stationName = `${faker.word.noun()} Station`;
    const stationNumber = faker.string.numeric(3);
    const appName = `E2E Isolation App ${faker.string.alphanumeric(6)}`;

    // Tenant A: pair + approve a device, post a closed run.
    await signUp(page, { name: faker.person.fullName(), email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);

    await page.goto(`${baseA}/admin/devices`);
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
    const authRes = await request.post(`${API_URL}/api/v1/device/auth`, {
      data: { provisioningToken, fingerprint, hostname },
    });
    const { deviceToken } = (await authRes.json()) as { deviceToken: string };

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("button", { name: "New Station" }).click();
    await page.getByLabel("Station Name *").fill(stationName);
    await page.getByLabel("Station Number *").fill(stationNumber);
    await page.getByRole("button", { name: "Approve Device" }).click();
    await expect(page.getByText("Device approved")).toBeVisible();

    const devicesRes = await page.request.get(`${API_URL}/rpc/devices?page=1&pageSize=10`, {
      headers: { "x-tenant-slug": slugA },
    });
    const devicesBody = (await devicesRes.json()) as { items: { hostname: string; stationId: string }[] };
    const stationIdA = devicesBody.items.find((d) => d.hostname === hostname)?.stationId;
    expect(stationIdA).toBeTruthy();

    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const endedAt = new Date().toISOString();
    await request.post(`${API_URL}/api/v1/device/app-usage/events`, {
      headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Fingerprint": fingerprint },
      data: { launched: [{ runId: "e2e-iso-run", category: "app", appName, startedAt }], closed: [] },
    });
    await request.post(`${API_URL}/api/v1/device/app-usage/events`, {
      headers: { Authorization: `Bearer ${deviceToken}`, "X-Device-Fingerprint": fingerprint },
      data: { launched: [], closed: [{ runId: "e2e-iso-run", endedAt }] },
    });

    // Tenant B: separate owner, never touched A's device.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: faker.person.fullName(), email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);

    // Dashboard: tenant B's page never renders A's app/game.
    await pageB.goto(`${baseB}/admin/app-usage`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(appName)).toHaveCount(0);

    // API level, all three routes: tenant B's owner (holds appUsage:read)
    // gets a real 200 with zero of tenant A's rows — not a leak masked by a
    // permission denial.
    const from = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const to = encodeURIComponent(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    const currentResB = await pageB.request.get(`${API_URL}/rpc/app-usage/current?stationId=${stationIdA}`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(currentResB.ok()).toBeTruthy();
    const currentBodyB = (await currentResB.json()) as { items: unknown[] };
    expect(currentBodyB.items.length).toBe(0);

    const listResB = await pageB.request.get(`${API_URL}/rpc/app-usage?page=1&pageSize=50`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(listResB.ok()).toBeTruthy();
    const listBodyB = (await listResB.json()) as { items: { runId: string }[] };
    expect(listBodyB.items.some((r) => r.runId === "e2e-iso-run")).toBe(false);

    const summaryResB = await pageB.request.get(
      `${API_URL}/rpc/app-usage/summary?from=${from}&to=${to}&page=1&pageSize=50`,
      { headers: { "x-tenant-slug": slugB } },
    );
    expect(summaryResB.ok()).toBeTruthy();
    const summaryBodyB = (await summaryResB.json()) as { items: { appName: string }[] };
    expect(summaryBodyB.items.some((r) => r.appName === appName)).toBe(false);

    await ctxB.close();
  });
});
