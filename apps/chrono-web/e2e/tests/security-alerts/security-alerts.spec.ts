import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Security Alerts module (chrono/security-alerts).
 *
 * Per Phase 4 of .ai/plans/chrono/active/security-alerts/README.md:
 * - Happy path: owner reports an incident, acknowledges it, then resolves it with a
 *   required note.
 * - Role gate: a session lacking securityAlert:manage sees Acknowledge/Resolve/Report
 *   hidden; a direct API call 403s.
 * - Tenant isolation: tenant B never sees tenant A's alert; a direct cross-tenant
 *   acknowledge/resolve attempt 404s.
 */
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

async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<void> {
  await page.goto(`${base}/dashboard/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /add branch|create branch/i }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: /save|create/i }).last().click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("Security Alerts", () => {
  test("happy path: report, acknowledge, resolve", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2esecalert${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const branchName = `Branch ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Sec Owner", email: ownerEmail, slug });
    await createBranch(page, base, branchName);

    await page.goto(`${base}/dashboard/security-alerts`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Report Incident" }).click();
    // Branch select defaults to the first branch — no explicit selection needed.
    await page.getByLabel("Message").fill("Tamper switch triggered on kiosk 3.");
    await page.getByRole("button", { name: "Report incident" }).click();

    await expect(page.getByText("Incident reported.")).toBeVisible();
    await expect(page.getByText("Tamper switch triggered on kiosk 3.")).toBeVisible();
    await expect(page.getByText("open")).toBeVisible();

    await page.getByRole("button", { name: "Acknowledge" }).click();
    await expect(page.getByText("Alert acknowledged.")).toBeVisible();
    await expect(page.getByText("acknowledged")).toBeVisible();

    await page.getByRole("button", { name: "Resolve" }).click();
    await page.getByLabel("Resolution note").fill("Checked camera footage — false alarm.");
    await page.getByRole("button", { name: "Resolve", exact: true }).last().click();

    await expect(page.getByText("Alert resolved.")).toBeVisible();
    await expect(page.getByText("resolved")).toBeVisible();
  });

  test("role gate: staff without securityAlert:manage cannot report/acknowledge/resolve", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2esecgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2esecgateinv${uniq}`;
    const branchName = `Branch ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Sec Owner", email: ownerEmail, slug });
    await createBranch(page, base, branchName);

    // Owner reports an alert so there is a row to try acting on as staff.
    await page.goto(`${base}/dashboard/security-alerts`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Report Incident" }).click();
    await page.getByLabel("Message").fill("Camera flagged unusual motion.");
    await page.getByRole("button", { name: "Report incident" }).click();
    await expect(page.getByText("Camera flagged unusual motion.")).toBeVisible();

    // Invite staff. Chrono's staff grants do not include securityAlert:manage
    // (only :read) — see apps/chrono-api/src/auth/permissions.ts.
    await page.goto(`${base}/dashboard/settings/members`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Sec Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    await page.goto(`${base}/dashboard/security-alerts`);
    await page.waitForLoadState("networkidle");

    // Feed is still visible (securityAlert:read), but every manage action is hidden.
    await expect(page.getByText("Camera flagged unusual motion.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Report Incident" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);

    // Server gate confirmed directly, not just UI visibility.
    const alertsRes = await page.request.get(`${base}/api/rpc/security-alerts`, {
      params: { pageSize: "10" },
    });
    expect(alertsRes.ok()).toBeTruthy();
    const alertsBody = (await alertsRes.json()) as { items: { id: string }[] };
    const alertId = alertsBody.items[0]!.id;

    const ackRes = await page.request.post(
      `${base}/api/rpc/security-alerts/${alertId}/acknowledge`,
    );
    expect(ackRes.status()).toBe(403);
  });

  test("tenant isolation: tenant B never sees tenant A's alert, direct API 404s", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2eseciso a${uniq}`.replace(/\s/g, "");
    const slugB = `e2eseciso b${uniq}`.replace(/\s/g, "");
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const branchNameA = `Branch A ${uniq}`;
    const branchNameB = `Branch B ${uniq}`;
    const message = `Isolation target ${uniq}`;
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);

    await page.goto(`${baseA}/dashboard/security-alerts`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Report Incident" }).click();
    await page.getByLabel("Message").fill(message);
    await page.getByRole("button", { name: "Report incident" }).click();
    await expect(page.getByText(message)).toBeVisible();

    const alertsResA = await page.request.get(`${baseA}/api/rpc/security-alerts`, {
      params: { pageSize: "10" },
    });
    const alertsBodyA = (await alertsResA.json()) as { items: { id: string }[] };
    const alertIdA = alertsBodyA.items[0]!.id;

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);

    await pageB.goto(`${baseB}/dashboard/security-alerts`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(message)).toHaveCount(0);

    const crossAck = await pageB.request.post(
      `${baseB}/api/rpc/security-alerts/${alertIdA}/acknowledge`,
    );
    expect(crossAck.status()).toBe(404);

    const crossResolve = await pageB.request.post(
      `${baseB}/api/rpc/security-alerts/${alertIdA}/resolve`,
      { data: { resolutionNote: "Hacked" } },
    );
    expect(crossResolve.status()).toBe(404);

    await ctxB.close();
  });
});
