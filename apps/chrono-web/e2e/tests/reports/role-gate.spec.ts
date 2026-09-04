import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Role gate for the Reports module (chrono/reports).
 *
 * Per Phase 5 of .ai/plans/chrono/active/reports/README.md: a `staff` session
 * can view the branch-scoped sales summary but the "Wallet activity" link is
 * hidden (visibility gate on `report:readFinancial`) and a direct API call
 * 403s; an `admin`/`owner` session can see and use both.
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
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

test.describe("Reports — role gate", () => {
  test("staff cannot see/use wallet-activity report; admin/owner can", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2erptgate${uniq}`;
    const staffSlug = `e2erptgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // Owner (holds report:readFinancial) sees the Wallet activity link and can load it.
    await page.goto(`${base}/admin/reports`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Wallet activity" })).toBeVisible();
    await page.getByRole("link", { name: "Wallet activity" }).click();
    await page.waitForURL(`${base}/admin/reports/wallet`);
    await expect(page.getByText(/error|forbidden/i)).toHaveCount(0);

    // Invite staff.
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // Staff: overview + sales report visible, wallet-activity link hidden.
    await page.goto(`${base}/admin/reports`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Sales report" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Wallet activity" })).toHaveCount(0);

    // Direct navigation still 403s server-side even without the link.
    const res = await page.request.get(
      `${base}/rpc/reports/wallet-activity?from=2020-01-01&to=2020-01-31`,
    );
    expect(res.status()).toBe(403);
  });
});
