import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser coverage for the `hidePlatformBranding` toggle
 * (`.ai/plans/chrono/in-progress/growth-loop-hardening/README.md`, Phase 3):
 * an owner can hide the "Powered by Chrono" credit from `TenantFooter`, and
 * the change applies immediately (no publish step) across the tenant's
 * public site and its `/login` chrome.
 *
 * Runs against the real dev servers (web :3000 + api :8787); needs `pnpm dev`
 * already running (the config declares no `webServer`).
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
  await page.getByLabel("Business name").fill(slug); // slug auto-derives
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
    timeout: 60_000,
  });
}

test.describe("Platform visibility (hidePlatformBranding)", () => {
  test("toggling it on hides \"Powered by Chrono\" on the public site and /login immediately", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrandvis${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });

    await signUpBusiness(page, { name: "Branding Owner", email, slug });

    // The owner's own admin session — toggle the setting.
    await page.goto(`http://${slug}.localtest.me:3000/admin/settings/branding`);
    const toggle = page.getByRole("switch", { name: /hide "powered by chrono"/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // The switch flips optimistically before its PATCH resolves — wait for
    // the actual response, not just the (immediate) UI state, or the public
    // page below can be read before the write has landed.
    const patchOn = page.waitForResponse(
      (res) =>
        res.url().includes("/rpc/branding/platform-visibility") &&
        res.request().method() === "PATCH",
    );
    await toggle.click();
    await patchOn;
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // A fresh, signed-out context — the change must be visible with no
    // publish step and with no dependency on the owner's own session.
    const ctx = await browser.newContext();
    const publicPage = await ctx.newPage();

    await publicPage.goto(`http://${slug}.localtest.me:3000/`);
    await expect(publicPage.getByText("Powered by Chrono")).not.toBeVisible();

    await publicPage.goto(`http://${slug}.localtest.me:3000/login`);
    await expect(publicPage.getByText("Powered by Chrono")).not.toBeVisible();

    // Toggling back off restores the default, immediately, no publish step.
    await page.reload();
    const toggleAfterReload = page.getByRole("switch", {
      name: /hide "powered by chrono"/i,
    });
    await expect(toggleAfterReload).toHaveAttribute("aria-checked", "true");
    const patchOff = page.waitForResponse(
      (res) =>
        res.url().includes("/rpc/branding/platform-visibility") &&
        res.request().method() === "PATCH",
    );
    await toggleAfterReload.click();
    await patchOff;
    await expect(toggleAfterReload).toHaveAttribute("aria-checked", "false");

    await publicPage.goto(`http://${slug}.localtest.me:3000/`);
    await expect(publicPage.getByText("Powered by Chrono")).toBeVisible();

    await ctx.close();
  });

  test("a second, untouched tenant still shows \"Powered by Chrono\" — the setting never leaks cross-tenant", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrandvisb${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });

    await signUpBusiness(page, { name: "Untouched Owner", email, slug });

    await page.goto(`http://${slug}.localtest.me:3000/`);
    await expect(page.getByText("Powered by Chrono")).toBeVisible();
  });
});
