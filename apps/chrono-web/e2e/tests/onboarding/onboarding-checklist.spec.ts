import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the onboarding checklist (chrono/onboarding).
 *
 * Per Phase 5 of .ai/plans/chrono/active/onboarding-checklist/README.md:
 * - Happy path: sign up a fresh tenant, assert the card shows 0/7, create a
 *   branch via the real branches flow, reload, assert the count increments.
 * - "Role gate" (really an `actionable`-flag test — no permission is
 *   introduced by this feature): a staff session sees the same
 *   completedCount/total as an owner, but with `actionable: false` on
 *   exactly the four items staff lacks permission to action (verified
 *   against the real CHRONO_STAFF_GRANTS below), rendered as "Ask an admin"
 *   rather than a "Start" link. Also: staff can still dismiss.
 * - Tenant isolation: completing an item in tenant A never affects tenant
 *   B's checklist.
 *
 * Which four items staff lacks `actionable` on — verified against the real
 * apps/chrono-api/src/auth/permissions.ts CHRONO_STAFF_GRANTS (staff holds no
 * `branch`, no `staff`, `pos: ["read","sell"]` with no `manageProducts`, and
 * no `device` resource at all):
 *   - createBranch   requires branch:create      -> staff lacks it
 *   - inviteStaff    requires staff:invite       -> staff lacks it
 *   - addProducts    requires pos:manageProducts -> staff lacks it
 *   - pairDevice     requires device:manage      -> staff lacks it
 * The other three (addStationGroup, addStation, openShift) require
 * station:create / shift:open, both of which staff holds.
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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

type ChecklistItemState = {
  key: string;
  label: string;
  description: string;
  href: string;
  stage: string;
  done: boolean;
  actionable: boolean;
};
type ChecklistState = {
  items: ChecklistItemState[];
  completedCount: number;
  total: number;
  allDone: boolean;
  dismissed: boolean;
};

async function getChecklist(
  page: import("@playwright/test").Page,
  base: string,
): Promise<ChecklistState> {
  const res = await page.request.get(`${base}/api/rpc/onboarding/checklist`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ChecklistState;
}

const STAFF_NOT_ACTIONABLE = new Set([
  "createBranch",
  "inviteStaff",
  "addProducts",
  "pairDevice",
]);

test.describe("Onboarding checklist", () => {
  test("happy path: 0/7 on signup, card visible, count increments after creating a branch", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eonb${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // Card renders on the dashboard, 0 of 7 complete.
    await expect(page.getByText("Get set up")).toBeVisible();
    await expect(page.getByText("0 of 7 steps complete")).toBeVisible();

    const initial = await getChecklist(page, base);
    expect(initial.dismissed).toBe(false);
    expect(initial.total).toBe(7);
    expect(initial.completedCount).toBe(0);
    expect(initial.items.every((i) => !i.done)).toBe(true);

    // Complete the "create a branch" item via the real branches flow.
    const branchName = `${faker.company.name()} Branch`;
    await page.goto(`${base}/dashboard/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add Branch" }).click();
    await page.getByLabel("Name").fill(branchName);
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByText(branchName)).toBeVisible();

    // Reload the dashboard and confirm the count incremented.
    await page.goto(`${base}/dashboard`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("1 of 7 steps complete")).toBeVisible();

    const afterBranch = await getChecklist(page, base);
    expect(afterBranch.completedCount).toBe(1);
    const branchItem = afterBranch.items.find((i) => i.key === "createBranch");
    expect(branchItem?.done).toBe(true);
  });

  test("actionable flag: staff sees the same counts as owner but 4 items read-only, and staff can still dismiss", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eonbgate${uniq}`;
    const staffSlug = `e2eonbgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    const ownerState = await getChecklist(page, base);
    expect(ownerState.total).toBe(7);
    // Owner (system role) holds every permission, so every item is actionable.
    expect(ownerState.items.every((i) => i.actionable)).toBe(true);

    // Invite staff.
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Log in as staff and accept the invite.
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    const staffState = await getChecklist(page, base);
    expect(staffState.total).toBe(ownerState.total);
    expect(staffState.completedCount).toBe(ownerState.completedCount);

    for (const item of staffState.items) {
      if (STAFF_NOT_ACTIONABLE.has(item.key)) {
        expect(item.actionable, `expected "${item.key}" to be non-actionable for staff`).toBe(
          false,
        );
      } else {
        expect(item.actionable, `expected "${item.key}" to be actionable for staff`).toBe(true);
      }
    }
    // Exactly the four expected items are non-actionable, no more, no fewer.
    const nonActionableKeys = staffState.items.filter((i) => !i.actionable).map((i) => i.key);
    expect(new Set(nonActionableKeys)).toEqual(STAFF_NOT_ACTIONABLE);

    // The card renders those four as "Ask an admin" (no "Start" link) and
    // the rest as actionable "Start" links.
    await page.goto(`${base}/dashboard`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Ask an admin")).toHaveCount(STAFF_NOT_ACTIONABLE.size);

    // Dismissal is deliberately ungated — staff can dismiss the card.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Get set up")).toHaveCount(0);
    const dismissedState = await getChecklist(page, base);
    expect(dismissedState.dismissed).toBe(true);
  });

  test("tenant isolation: completing an item in tenant A never affects tenant B's checklist", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2eonba${uniq}`;
    const slugB = `e2eonbb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Both start at 0/7.
    const beforeA = await getChecklist(page, baseA);
    const beforeB = await getChecklist(pageB, baseB);
    expect(beforeA.completedCount).toBe(0);
    expect(beforeB.completedCount).toBe(0);

    // Complete "create a branch" in tenant A only.
    const branchName = `${faker.company.name()} Branch`;
    await page.goto(`${baseA}/dashboard/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add Branch" }).click();
    await page.getByLabel("Name").fill(branchName);
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByText(branchName)).toBeVisible();

    const afterA = await getChecklist(page, baseA);
    expect(afterA.completedCount).toBe(1);
    expect(afterA.items.find((i) => i.key === "createBranch")?.done).toBe(true);

    // Tenant B is completely unaffected.
    const afterB = await getChecklist(pageB, baseB);
    expect(afterB.completedCount).toBe(0);
    expect(afterB.items.find((i) => i.key === "createBranch")?.done).toBe(false);

    await ctxB.close();
  });
});
