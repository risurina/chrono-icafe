import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Browser coverage for the platform admin notification-template surface:
 * `GET`/`PUT`/`DELETE /rpc-admin/notification-templates/:key` +
 * `POST .../test`, surfaced on `/admin/notifications`. Not tenant-scoped —
 * no tenant-isolation angle to prove — so this covers the role gate and a
 * full save → real-send → restore round trip instead, reading the outbound
 * subject straight out of the dev server's `EMAIL_PROVIDER=console` log (same
 * technique as `members-invite.spec.ts`).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";

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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

/** Best-effort cleanup: revert a seeded account's platform role to null. */
async function revokeRole(adminPage: import("@playwright/test").Page, email: string) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const target = body.items.find((i) => i.email === email);
  if (!target) return;
  await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${target.userId}/role`, {
    headers: { "x-platform-admin": "1" },
    data: { role: null },
  });
}

/** Poll the dev server log for a `[email:console]` line whose subject matches. */
async function findLoggedSubject(
  toEmail: string,
  subjectPattern: RegExp,
): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  const toPattern = new RegExp(
    `\\[email:console\\] to=${toEmail.replace(/[.+]/g, "\\$&")}.*`,
  );
  while (Date.now() < deadline) {
    const log = readFileSync(DEV_LOG_PATH, "utf8");
    const lines = log.split("\n").filter((l) => toPattern.test(l));
    if (lines.some((l) => subjectPattern.test(l))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function requestPasswordReset(
  page: import("@playwright/test").Page,
  slug: string,
  email: string,
) {
  await page.goto(`http://${slug}.localtest.me:3000/forgot-password`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /send reset link/i }).click();
  await expect(page.getByText(/a reset link is on its way/i)).toBeVisible();
}

test.describe("Platform Admin — Notification Templates", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeRole(page, "owner@acme.test");
    // Best-effort: always restore reset-password to its default afterward so
    // this spec never leaves the platform sending a test-authored template.
    await page.request.delete(
      `${API_URL}/rpc-admin/notification-templates/reset-password`,
      { headers: { "x-platform-admin": "1" } },
    );
    await ctx.close();
  });

  test("a platform viewer is blocked from save/test-send/restore but can read", async ({
    page,
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const acmeMembersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?search=acme`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(acmeMembersRes.ok()).toBeTruthy();
    const acmeOrgBody = (await acmeMembersRes.json()) as { items: { id: string }[] };
    const acmeId = acmeOrgBody.items[0]?.id;
    expect(acmeId).toBeTruthy();
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(membersRes.ok()).toBeTruthy();
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const acmeOwner = membersBody.items.find((m) => m.email === "owner@acme.test");
    expect(acmeOwner).toBeTruthy();

    const grantRes = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${acmeOwner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });

    // Read access works.
    const getRes = await page.request.get(
      `${API_URL}/rpc-admin/notification-templates/reset-password`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(getRes.ok()).toBeTruthy();

    // Every mutating action is rejected server-side — not merely hidden.
    const putRes = await page.request.put(
      `${API_URL}/rpc-admin/notification-templates/reset-password`,
      {
        headers: { "x-platform-admin": "1" },
        data: { subject: "x", bodyHtml: "<p>{{link}}</p>" },
      },
    );
    expect(putRes.status()).toBe(403);

    const testRes = await page.request.post(
      `${API_URL}/rpc-admin/notification-templates/reset-password/test`,
      {
        headers: { "x-platform-admin": "1" },
        data: {
          toEmail: "owner@acme.test",
          subject: "x",
          bodyHtml: "<p>{{link}}</p>",
        },
      },
    );
    expect(testRes.status()).toBe(403);

    const deleteRes = await page.request.delete(
      `${API_URL}/rpc-admin/notification-templates/reset-password`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(deleteRes.status()).toBe(403);

    // The UI itself hides the manage controls (visibility only).
    await page.goto("http://localtest.me:3000/admin/notifications/reset-password");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Restore default" }),
    ).toHaveCount(0);

    await adminContext.close();
  });

  test("admin saves a distinctive reset-password body; a real reset uses it; restore-default reverts it", async ({
    page,
  }) => {
    const uniq = Date.now();
    const marker = `E2E-MARKER-${uniq}`;
    const slug = `test-notif${uniq}`;
    const ownerEmail = `test-notif-owner${uniq}@example.com`;

    // Seed a real tenant + owner to actually drive a password reset against.
    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("Notif Owner");
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
    await page.getByLabel("Business name").fill(slug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 60_000,
    });

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await page.goto("http://localtest.me:3000/admin/notifications/reset-password");
    await page.waitForLoadState("networkidle");

    const subjectInput = page.getByLabel("Subject");
    await subjectInput.fill(`Reset your password ${marker}`);
    const bodyInput = page.getByLabel("Body (HTML)");
    await bodyInput.fill(`<p>Click here: {{link}}</p>`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Template saved.")).toBeVisible();
    await expect(page.getByText("Customized")).toBeVisible();

    // Drive the REAL /reset-password request flow on the new tenant and
    // confirm the outgoing email's subject carries the saved override text,
    // not the hardcoded default.
    await requestPasswordReset(page, slug, ownerEmail);
    const foundOverride = await findLoggedSubject(
      ownerEmail,
      new RegExp(marker.replace(/[-]/g, "\\-")),
    );
    expect(foundOverride).toBe(true);

    // Restore default — subsequent resets use the built-in copy again.
    await page.goto("http://localtest.me:3000/admin/notifications/reset-password");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Restore default" }).click();
    await page.getByRole("button", { name: "Restore default" }).last().click();
    await expect(page.getByText("Restored to the default template.")).toBeVisible();
    await expect(page.getByText("Default").first()).toBeVisible();

    await requestPasswordReset(page, slug, ownerEmail);
    const foundDefault = await findLoggedSubject(
      ownerEmail,
      /subject="Reset your password"/,
    );
    expect(foundDefault).toBe(true);
  });
});
