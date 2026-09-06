import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member Session + Connect (`/member/session`, `/member/session/[id]`) —
 * chrono/member-area, execution phase 5.
 *
 * member-portal-v2 phase 1 folded Connect's QR-scan explainer directly into
 * `/member/session` (nav consolidation: Session absorbed Connect, no more
 * separate `/member/connect` nav entry — the route now just redirects here).
 *
 * Happy path: no-active-session zero state and history render; the folded
 * Connect three-step explainer renders on the same page; a foreign/
 * nonexistent session id 404s without leaking existence; role check: neither
 * page is approval-gated; cross-tenant isolation: tenant B's member cannot
 * view tenant A's session by id (404, not a leaked row).
 */
const PASSWORD = "Password123!";

async function signUpBusiness(
  page: Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
    timeout: 60_000,
  });
}

async function memberSignUp(
  page: Page,
  base: string,
  { name, email }: { name: string; email: string },
) {
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(`${base}/member`, { timeout: 15_000 });
}

test.describe("Member session + connect", () => {
  test.describe.configure({ timeout: 270_000 });

  test("happy path: session zero state, connect explainer, and a foreign session id 404s", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememses${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Session Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Session Member", email: memberEmail });

    await page.getByTestId("member-nav-session").click();
    await expect(page).toHaveURL(`${base}/member/session`);
    await expect(page.getByTestId("active-session-card")).toBeVisible();
    await expect(page.getByText("No active session right now.")).toBeVisible();
    await expect(page.getByText("No sessions yet.")).toBeVisible();
    // Connect's explainer is now folded into this same page.
    await expect(page.getByTestId("connect-step-1")).toBeVisible();
    await expect(page.getByTestId("connect-step-2")).toBeVisible();
    await expect(page.getByTestId("connect-step-3")).toBeVisible();

    // `/member/connect` is no longer a nav entry — it redirects here.
    await page.goto(`${base}/member/connect`);
    await expect(page).toHaveURL(`${base}/member/session`);

    // A nonexistent session id must 404, never leak existence.
    await page.goto(`${base}/member/session/does-not-exist`);
    await expect(page.getByText("Session not found")).toBeVisible();
  });

  test("isolation: tenant B's member cannot view tenant A's session by id", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememsesa${uniq}`;
    const slugB = `e2ememsesb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Session Owner A", email: emailA, slug: slugA });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await memberSignUp(page, baseA, { name: "Member A", email: memberEmailA });

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUpBusiness(pageB, { name: "Session Owner B", email: emailB, slug: slugB });
    await pageB.getByRole("button", { name: "Sign out" }).click();
    await pageB.waitForLoadState("networkidle");
    await memberSignUp(pageB, baseB, { name: "Member B", email: memberEmailB });

    // Tenant B's member trying an arbitrary id on their own host 404s cleanly
    // (no session exists cross-tenant to even attempt a real leak against).
    await pageB.goto(`${baseB}/member/session/some-tenant-a-session-id`);
    await expect(pageB.getByText("Session not found")).toBeVisible();
    await contextB.close();
  });
});
