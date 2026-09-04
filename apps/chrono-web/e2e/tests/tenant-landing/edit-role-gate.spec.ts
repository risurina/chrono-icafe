import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Role-gate coverage for the tenant-landing settings editor
 * (chrono/tenant-landing), Phase 5 of
 * .ai/plans/chrono/active/tenant-landing/README.md.
 *
 * A `staff` session cannot see or use the editor's Save control
 * (`<Can resource="landingPage" action="manage">` hides the whole form);
 * a direct API PATCH also 403s. `admin`/`owner` can save, and the change is
 * reflected on the public /about page afterward.
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
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
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

test.describe("Tenant landing — editor role gate", () => {
  test("staff cannot save the editor; admin/owner can, and /about reflects it", async ({
    page,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2elandgate${uniq}`;
    const staffSlug = `e2elandgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    // Owner sets up the business.
    await signUp(page, { name: "Landing Owner", email: ownerEmail, slug });

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

    // Login as staff and accept the invite.
    await signUp(page, { name: "Landing Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // Staff visits the editor: no Save control, form is hidden entirely.
    await page.goto(`${base}/admin/settings/landing-page`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByLabel("Hero tagline")).toHaveCount(0);

    // A direct API PATCH from the staff session 403s.
    const staffCookies = await page.context().cookies();
    const directPatch = await request.patch(`${base}/rpc/landing-page`, {
      headers: {
        cookie: staffCookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "content-type": "application/json",
        "x-tenant-slug": slug,
      },
      data: { heroTagline: "staff forced write" },
    });
    expect(directPatch.status()).toBe(403);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Owner (admin+) can save, and the change is reflected on /about.
    await page.goto(`${base}/admin/login`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    const heroTagline = `${faker.company.catchPhrase()} — owner saved`;
    await page.goto(`${base}/admin/settings/landing-page`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Hero tagline").fill(heroTagline);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Landing page updated.")).toBeVisible();

    const aboutRes = await request.get(`${base}/about`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(aboutRes.ok()).toBeTruthy();
    const aboutHtml = await aboutRes.text();
    expect(aboutHtml).toContain(heroTagline);
  });
});
