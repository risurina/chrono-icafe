import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Structured hours editor on the branch/venue settings dashboard page
 * (`.ai/plans/chrono/in-progress/tenant-experience-v2/README.md` Phase 1b).
 *
 * Phase 1a already covers `computeOpenStatus` itself (unit-tested) and the
 * public read path (`apps/chrono-web/e2e/tests/venue-info/dynamic-hours.spec.ts`,
 * which patches `hoursConfig` directly via the API). This spec instead drives
 * the real dashboard UI end to end: the day-of-week editor added to
 * `apps/chrono-web/src/app/(tenant-admin)/dashboard/branches/page.tsx`, the
 * `branch:update` role gate, and the resulting `/public/venue-info` read.
 *
 * Every case sets every day to "24 hours" so the assertions are correct at
 * any moment the test runs, without controlling wall-clock time — same
 * time-independence rationale as `dynamic-hours.spec.ts`.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
const SEEDED_PASSWORD = "Password123!";

const DAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

async function signUp(
  page: Page,
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

async function findInviteLink(toEmail: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  // Case-insensitive: the invite backend normalizes recipient emails to
  // lowercase before logging/sending (standard email-address handling), but
  // faker-generated addresses aren't always already lowercase — a
  // case-sensitive match here is flaky, not a real assertion on casing.
  const pattern = new RegExp(
    `\\[email:console\\] to=${toEmail.replace(/[.+]/g, "\\$&")}.*?link=(\\S+)`,
    "i",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(DEV_LOG_PATH, "utf8");
    const match = log.match(pattern);
    if (match?.[1]) return match[1];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
}

/** Sets every day-of-week row in the currently-open branch dialog to "24 hours". */
async function setAllDaysTo24h(page: Page) {
  for (const day of DAY_LABELS) {
    await page.getByLabel(`${day} hours`).click();
    await page.getByRole("option", { name: "24 hours" }).click();
  }
}

/**
 * Sign-up auto-provisions a default "Main" branch, but as a fire-and-forget
 * call made from the root `/admin` dashboard page only (`onboarding-defaults.ts`)
 * — not from `/admin/branches`. `signUp()` already lands on `/admin`, so wait
 * here for that provisioning call's own completion toast before navigating
 * away — a page-request API poll doesn't reliably carry the session's cookie
 * cross-origin (`localtest.me` -> `localhost:8787`) the way the real browser
 * fetch (`tenantFetch`) does.
 */
async function waitForMainBranch(page: Page): Promise<void> {
  await expect(page.getByText(/Set up a default/i)).toBeVisible({ timeout: 15_000 });
}

test.describe("Branch dashboard — structured hours editor", () => {
  test("an owner can save structured hours, and they reflect immediately on the public site", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrho${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Hours Owner", email, slug });
    // Edit the auto-provisioned "Main" branch directly rather than adding a
    // second one: `/public/venue-info` only ever serves the tenant's FIRST
    // active branch (oldest by `createdAt`, `apps/chrono-api/AGENTS.md`), so a
    // second branch's hours would never reach that endpoint.
    await waitForMainBranch(page);

    await page.goto(`${base}/admin/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Edit Main" }).click();
    await setAllDaysTo24h(page);
    // The post-save `load()` refetch is a fire-and-forget call the save
    // handler doesn't await, so wait for its response explicitly rather than
    // `networkidle` (which can resolve in the gap before that fetch starts) —
    // otherwise the dialog re-opened below can briefly pre-fill from the
    // pre-save row still held in state.
    const refetch = page.waitForResponse(
      (res) => res.url().includes("/rpc/branches") && res.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Branch updated.")).toBeVisible();
    await refetch;

    // Re-open the dialog: the editor must pre-fill from the saved config, not
    // just accept writes.
    await page.getByRole("button", { name: "Edit Main" }).click();
    await expect(page.getByLabel("Monday hours")).toContainText("24 hours");
    await page.keyboard.press("Escape");

    // Reflects immediately on the public site — no deploy, no manual refresh
    // beyond the venue-info route's own short cache (cold for a brand-new
    // tenant on its first read).
    await page.context().clearCookies();
    const res = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      branch: { openStatus: { isOpen: boolean; opensAt: string | null } | null } | null;
    };
    expect(body.branch?.openStatus?.isOpen).toBe(true);
    expect(body.branch?.openStatus?.opensAt).toBeNull();
  });

  test("a staff-role member is blocked from saving structured hours", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrhr${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2ebrhrinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Hours Owner", email: ownerEmail, slug });
    // Main is provisioned against the OWNER's own tenant; confirm it landed
    // before the staff account (a separate org) ever gets invited into it.
    await waitForMainBranch(page);

    // Invite a teammate (default role: staff — no branch:update).
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await signUp(page, { name: "Hours Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    await page.goto(`${base}/admin/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Edit Main" }).click();
    await setAllDaysTo24h(page);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Only admins can manage branches.")).toBeVisible();

    // The write never landed: the public page has no computed status at all
    // (no `hoursConfig` was ever saved for this branch).
    await page.context().clearCookies();
    const res = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { branch: { openStatus: unknown } | null };
    expect(body.branch?.openStatus).toBeNull();
  });
});
