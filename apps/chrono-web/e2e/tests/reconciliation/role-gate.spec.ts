import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Phase 6 (role gate) of .ai/plans/chrono/active/reconciliation/README.md.
 *
 * Open Question 1's resolved default: `reconciliation:read` is granted to
 * `staff`/`admin`/`owner` alike with no per-role split — any staff member can
 * read any shift's breakdown, not just their own (anti-theft transparency).
 * This asserts that default: an invited `staff` member can read a shift the
 * `owner` opened and closed.
 */
const SEEDED_PASSWORD = "Password123!";

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

async function findInviteLink(toEmail: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
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
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
}

async function createBranch(page: import("@playwright/test").Page, base: string, name: string) {
  const res = await page.request.post(`${base}/api/rpc/branches`, {
    data: { name, code: name.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X"), status: "active" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { branch: { id: string } };
  return body.branch.id;
}

async function openShift(
  page: import("@playwright/test").Page,
  base: string,
  branchId: string,
  openingCashAmount: string,
) {
  const res = await page.request.post(`${base}/api/rpc/shifts/open`, {
    data: { branchId, openingCashAmount },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { shift: { id: string } };
  return body.shift.id;
}

test.describe("Reconciliation — role gate", () => {
  test("staff and admin/owner can both read a shift's breakdown; no own-shifts-only split", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2ereconrbac${uniq}`;
    const staffSlug = `e2ereconrbacinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Recon Owner", email: ownerEmail, slug });
    const branchId = await createBranch(page, base, `Branch ${uniq}`);

    // Owner opens and closes a shift with a variance.
    const shiftId = await openShift(page, base, branchId, "40.00");
    const closeRes = await page.request.post(`${base}/api/rpc/shifts/${shiftId}/close`, {
      data: { actualCashAmount: "45.00" },
    });
    expect(closeRes.ok()).toBeTruthy();

    // The owner can read the breakdown.
    const ownerReadRes = await page.request.get(`${base}/api/rpc/reconciliation/shifts/${shiftId}`);
    expect(ownerReadRes.ok()).toBeTruthy();
    const ownerReadBody = (await ownerReadRes.json()) as {
      summary: { expectedCashAmount: string | null; differenceAmount: string | null };
    };
    expect(ownerReadBody.summary.expectedCashAmount).toBe("40.00");
    expect(ownerReadBody.summary.differenceAmount).toBe("5.00");

    // Invite a staff member.
    await page.goto(`${base}/dashboard/settings/members`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Recon Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Staff — who did not open or close this shift — can still read its
    // breakdown, per the "no split" default.
    const staffReadRes = await page.request.get(`${base}/api/rpc/reconciliation/shifts/${shiftId}`);
    expect(staffReadRes.ok()).toBeTruthy();
    const staffReadBody = (await staffReadRes.json()) as {
      summary: { expectedCashAmount: string | null; differenceAmount: string | null };
    };
    expect(staffReadBody.summary.expectedCashAmount).toBe("40.00");
    expect(staffReadBody.summary.differenceAmount).toBe("5.00");

    // Staff can also see it surfaced in the dashboard's variance table.
    await page.goto(`${base}/dashboard/reconciliation`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("5.00").first()).toBeVisible();
  });
});
