import { test, expect } from "@playwright/test";

/**
 * Tenant-scoped browser coverage for the self-serve Features page
 * (`{slug}.localtest.me:3000/dashboard/settings/features`) after global feature
 * management landed: the page shows the RESOLVED value (what is actually on for
 * the tenant), and when a platform rule (kill switch / plan gate) overrides the
 * owner's own toggle it surfaces a reason instead of silently snapping back —
 * the PUT still writes the owner's override.
 *
 * The kill switch is PLATFORM-GLOBAL, so the test restores the key it touches
 * in `afterEach`. Runs `workers: 1` against the real dev DB; needs `pnpm dev`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const HDR = { "x-platform-admin": "1" };

const KEY = "reports.advanced";
const KEY_LABEL = "Advanced reports";

async function signUpWorkspace(
  page: import("@playwright/test").Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function signInStaff(
  page: import("@playwright/test").Page,
  host: string,
  email: string,
) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

async function setGlobal(
  page: import("@playwright/test").Page,
  data: Record<string, unknown>,
) {
  const res = await page.request.patch(`${API_URL}/rpc-admin/feature-flags/${KEY}`, {
    headers: HDR,
    data,
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("Tenant Features — resolved value + override reason", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await setGlobal(page, {
      status: "active",
      globalDefault: false,
      rolloutPercentage: null,
      planAvailability: null,
    });
    await ctx.close();
  });

  test("owner sees the resolved global default without an override", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-rv-def${uniq}`;
    await signUpWorkspace(page, {
      name: "RV Default",
      email: `test-rv-def-owner${uniq}@example.com`,
      slug,
    });

    // Turn the feature ON globally (globalDefault) as the platform admin.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await setGlobal(adminPage, { globalDefault: true });

    // The owner, with no override of their own, sees the resolved ON value.
    await page.goto(`http://${slug}.localtest.me:3000/dashboard/settings/features`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("switch", { name: `Toggle ${KEY_LABEL}` })).toBeChecked();

    await adminCtx.close();
  });

  test("when killed platform-wide, the page shows the reason and does not report ON even after the owner toggles it", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-rv-kill${uniq}`;
    await signUpWorkspace(page, {
      name: "RV Kill",
      email: `test-rv-kill-owner${uniq}@example.com`,
      slug,
    });

    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await setGlobal(adminPage, { status: "disabled" });

    await page.goto(`http://${slug}.localtest.me:3000/dashboard/settings/features`);
    await page.waitForLoadState("networkidle");

    const toggle = page.getByRole("switch", { name: `Toggle ${KEY_LABEL}` });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(/disabled platform-wide/i)).toBeVisible();

    // The owner turns it ON — the PUT is accepted (writes their override) but
    // the resolved value stays OFF, and the switch never reports it as ON.
    await toggle.click();
    await expect(page.getByText(/disabled platform-wide, so it stays off/i)).toBeVisible();
    await expect(toggle).not.toBeChecked();

    // And it survives a reload (server truth, not optimistic UI).
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("switch", { name: `Toggle ${KEY_LABEL}` })).not.toBeChecked();
    await expect(page.getByText(/disabled platform-wide/i)).toBeVisible();

    await adminCtx.close();
  });
});
