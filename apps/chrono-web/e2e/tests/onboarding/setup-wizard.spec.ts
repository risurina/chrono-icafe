import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the onboarding setup wizard (chrono/onboarding,
 * onboarding-wizard plan, Phase 4 — the plan's last phase).
 *
 * Backend/UI verified in full before writing this spec:
 * - `apps/chrono-api/src/modules/onboarding/contracts.ts` — the seven items,
 *   in stage order (Venue: createBranch, addStationGroup, addStation; Team:
 *   inviteStaff; Trading: addProducts, pairDevice, openShift).
 * - `apps/chrono-web/src/app/admin/setup/page.tsx` — there is NO
 *   automatic redirect to /admin on allDone; it renders a "You're all
 *   set" card with an explicit "Go to dashboard" button. The active step is
 *   derived fresh from server state every load (first not-done item, stage
 *   order) — no stored cursor.
 * - Each step form under `.../steps/*.tsx` — real field labels/button text
 *   used below.
 *
 * Staff non-actionable set, verified against the real
 * `CHRONO_STAFF_GRANTS` in `apps/chrono-api/src/auth/permissions.ts` (no
 * `branch`, no `staff`, `pos: ["read","sell"]` with no `manageProducts`, no
 * `device` resource at all): createBranch, inviteStaff, addProducts,
 * pairDevice. The other three (addStationGroup, addStation, openShift)
 * require `station:create` / `shift:open`, both staff holds.
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

test.describe("Onboarding setup wizard", () => {
  test("happy path: complete all seven steps inline, then land on the completion card", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewiz${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    await page.goto(`${base}/admin/setup`);
    await page.waitForLoadState("networkidle");

    // 1. createBranch
    await expect(page.getByRole("heading", { name: "Create your first branch" })).toBeVisible();
    await page.getByLabel("Branch name").fill("Main Branch");
    await page.getByLabel("Branch code").fill("MAIN");
    await page.getByRole("button", { name: "Create branch" }).click();

    // 2. addStationGroup
    await expect(page.getByRole("heading", { name: "Add a station group" })).toBeVisible();
    await page.getByLabel("Group name").fill("Standard");
    await page.getByLabel("Group code").fill("STD");
    await page.getByLabel("Hourly rate").fill("30");
    await page.getByRole("button", { name: "Create station group" }).click();

    // 3. addStation
    await expect(page.getByRole("heading", { name: "Add a station" })).toBeVisible();
    await page.getByLabel("Station name").fill("PC 1");
    await page.getByLabel("Station number").fill("1");
    await page.getByRole("button", { name: "Create station" }).click();

    // 4. inviteStaff
    await expect(page.getByRole("heading", { name: "Invite a staff member" })).toBeVisible();
    const teammateEmail = faker.internet.email({ provider: "example.com" });
    await page.getByLabel("Email address").fill(teammateEmail);
    await page.getByRole("button", { name: "Send invite" }).click();

    // 5. addProducts
    await expect(page.getByRole("heading", { name: "Add POS products" })).toBeVisible();
    await page.getByLabel("Product name").fill("Soda");
    await page.getByLabel("Price").fill("25.00");
    await page.getByRole("button", { name: "Add product" }).click();

    // 6. pairDevice
    await expect(page.getByRole("heading", { name: "Create a device pairing code" })).toBeVisible();
    await page.getByLabel("Device name").fill("Front counter kiosk");
    await page.getByRole("button", { name: "Generate pairing code" }).click();
    // This step shows the resulting pairing code instead of advancing away
    // immediately — confirm it rendered, then move on ourselves.
    await expect(page.getByText(/^[A-Z0-9]+$/).first()).toBeVisible();

    // 7. openShift
    await page.goto(`${base}/admin/setup#openShift`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Open your first shift" })).toBeVisible();
    await page.getByLabel("Opening cash amount").fill("2000.00");
    await page.getByRole("button", { name: "Open shift" }).click();

    // No automatic redirect — the wizard shows an explicit completion card.
    await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible();
    const finalState = await getChecklist(page, base);
    expect(finalState.allDone).toBe(true);
    expect(finalState.completedCount).toBe(7);

    await page.getByRole("button", { name: "Go to dashboard" }).click();
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin$`));
    // The dashboard checklist card is gone once allDone.
    await expect(page.getByText("Get set up")).toHaveCount(0);
  });

  test("role gate: staff sees 4 locked / 3 actionable steps, and a forged branch-create call still 403s", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewizgate${uniq}`;
    const staffSlug = `e2ewizgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

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

    // Log in as staff and accept the invite.
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    const staffState = await getChecklist(page, base);
    expect(staffState.total).toBe(7);
    for (const item of staffState.items) {
      const expectedActionable = !STAFF_NOT_ACTIONABLE.has(item.key);
      expect(item.actionable, `expected "${item.key}" actionable=${expectedActionable}`).toBe(
        expectedActionable,
      );
    }

    await page.goto(`${base}/admin/setup`);
    await page.waitForLoadState("networkidle");

    // The stepper renders all seven steps; the four staff lacks are locked
    // (disabled) buttons, the other three are enabled.
    for (const item of staffState.items) {
      const stepButton = page.getByRole("button", { name: item.label });
      await expect(stepButton).toBeVisible();
      if (STAFF_NOT_ACTIONABLE.has(item.key)) {
        await expect(stepButton).toBeDisabled();
      } else {
        await expect(stepButton).toBeEnabled();
      }
    }

    // The active step's form itself also renders the "ask an admin" copy
    // when it's a non-actionable one (createBranch is first in stage order,
    // so it's the active step for a staff session with nothing done yet).
    await expect(page.getByText("Ask an admin to complete this step.")).toBeVisible();

    // Proves the lock is DISPLAY-ONLY, not the real security boundary: a
    // forged direct API call from this same staff session still 403s. This
    // must fail if requirePermission on POST /branches is ever removed.
    const forged = await page.request.post(`${base}/api/rpc/branches`, {
      data: { name: "Forged Branch", code: "FRG" },
    });
    expect(forged.status()).toBe(403);
  });

  test("tenant isolation: completing steps in tenant A never affects tenant B's wizard", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ewiza${uniq}`;
    const slugB = `e2ewizb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    const beforeA = await getChecklist(page, baseA);
    const beforeB = await getChecklist(pageB, baseB);
    expect(beforeA.completedCount).toBe(0);
    expect(beforeB.completedCount).toBe(0);

    // Complete the first two steps in tenant A only.
    await page.goto(`${baseA}/admin/setup`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Branch name").fill("Main Branch");
    await page.getByLabel("Branch code").fill("MAIN");
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByRole("heading", { name: "Add a station group" })).toBeVisible();
    await page.getByLabel("Group name").fill("Standard");
    await page.getByLabel("Group code").fill("STD");
    await page.getByLabel("Hourly rate").fill("30");
    await page.getByRole("button", { name: "Create station group" }).click();

    const afterA = await getChecklist(page, baseA);
    expect(afterA.completedCount).toBe(2);

    // Tenant B's wizard/checklist is completely unaffected.
    const afterB = await getChecklist(pageB, baseB);
    expect(afterB.completedCount).toBe(0);
    expect(afterB.items.every((i) => !i.done)).toBe(true);

    await ctxB.close();
  });

  test("resume: reloading the wizard after completing three steps resumes at the fourth", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewizresume${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    await page.goto(`${base}/admin/setup`);
    await page.waitForLoadState("networkidle");

    // Complete the three Venue-stage steps.
    await page.getByLabel("Branch name").fill("Main Branch");
    await page.getByLabel("Branch code").fill("MAIN");
    await page.getByRole("button", { name: "Create branch" }).click();

    await expect(page.getByRole("heading", { name: "Add a station group" })).toBeVisible();
    await page.getByLabel("Group name").fill("Standard");
    await page.getByLabel("Group code").fill("STD");
    await page.getByLabel("Hourly rate").fill("30");
    await page.getByRole("button", { name: "Create station group" }).click();

    await expect(page.getByRole("heading", { name: "Add a station" })).toBeVisible();
    await page.getByLabel("Station name").fill("PC 1");
    await page.getByLabel("Station number").fill("1");
    await page.getByRole("button", { name: "Create station" }).click();

    // Fourth step (first of the Team stage) becomes active with no reload yet.
    await expect(page.getByRole("heading", { name: "Invite a staff member" })).toBeVisible();

    // Reload the page entirely — no stored cursor of any kind — and confirm
    // it resumes at the same (fourth) step, not step one and not skipping
    // ahead.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Invite a staff member" })).toBeVisible();

    const state = await getChecklist(page, base);
    expect(state.completedCount).toBe(3);
    expect(state.items.filter((i) => i.done).map((i) => i.key).sort()).toEqual(
      ["createBranch", "addStationGroup", "addStation"].sort(),
    );
  });
});
