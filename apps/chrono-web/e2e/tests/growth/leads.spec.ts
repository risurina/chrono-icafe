import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Lead-detail console (`.ai/plans/chrono/in-progress/growth-loop-hardening`,
 * Phase 5): `GET /rpc/growth/leads` and the `/admin/growth` dashboard page.
 *
 * Mirrors the existing `growth/demand-role-gate.spec.ts` and
 * `growth/cross-tenant-isolation.spec.ts` fixtures/helpers exactly — same
 * console-driver invite-link pattern, same "business name IS the match key"
 * setup — scoped to the new `/leads` route and page instead of `/demand`.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
const SEEDED_PASSWORD = "Password123!";

async function findInviteLink(toEmail: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  // Case-insensitive: the invite backend normalizes recipient emails to
  // lowercase before logging/sending, but faker-generated addresses aren't
  // always already lowercase — a case-sensitive match here is flaky, not a
  // real assertion on casing.
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

async function submitLead(
  page: Page,
  { businessName, city, message }: { businessName: string; city?: string; message?: string },
) {
  await page.evaluate(
    async ({ apiUrl, businessName, city, message }) => {
      await fetch(`${apiUrl}/public/discover/business-leads`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessName, city, message }),
      });
    },
    { apiUrl: API_URL, businessName, city, message },
  );
}

test.describe("Growth lead-detail console", () => {
  test("owner sees the lead row; a real staff member is refused (403 + no admin copy)", async ({
    page,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2egrowthleads${uniq}`;
    const staffSlug = `e2egrowthleadsinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Leads Owner", email: ownerEmail, slug });

    // A player asks for this business by name, with a city and a message —
    // exactly the fields this route (and only this route) surfaces.
    await submitLead(page, {
      businessName: `  ${slug.toUpperCase()}  `,
      city: "Quezon City",
      message: "Please open a branch near me!",
    });

    // ── Happy path: the owner sees the lead's real fields on the page. ──
    await page.goto(`${base}/admin/growth`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Quezon City")).toBeVisible();
    await expect(page.getByText("Please open a branch near me!")).toBeVisible();

    // The response shape itself: exactly the 4 documented fields, never a
    // requester identity.
    const ownerCookies = await page.context().cookies();
    const asOwner = await request.get(`${API_URL}/rpc/growth/leads`, {
      headers: {
        cookie: ownerCookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-tenant-slug": slug,
      },
    });
    expect(asOwner.status()).toBe(200);
    const ownerBody = (await asOwner.json()) as { items: Record<string, unknown>[] };
    expect(ownerBody.items.length).toBe(1);
    expect(Object.keys(ownerBody.items[0]!).sort()).toEqual([
      "businessName",
      "city",
      "createdAt",
      "message",
    ]);

    // ── Invite a staff member ──
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Leads Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // ── Staff: refused at the API, and the page shows no lead data. ──
    const staffCookies = await page.context().cookies();
    const asStaff = await request.get(`${API_URL}/rpc/growth/leads`, {
      headers: {
        cookie: staffCookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-tenant-slug": slug,
      },
    });
    expect(asStaff.status(), "staff must never read leads — growth:read is admin+ only").toBe(403);

    await page.goto(`${base}/admin/growth`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Only admins can view player requests.")).toBeVisible();
    await expect(page.getByText("Quezon City")).not.toBeVisible();
  });

  test("a second, untouched business never sees another business's lead rows", async ({
    page,
    browser,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2egrowthleadsisoa${uniq}`;
    const slugB = `e2egrowthleadsisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });

    await signUp(page, { name: "Leads Iso A", email: emailA, slug: slugA });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Leads Iso B", email: emailB, slug: slugB });

    await submitLead(page, { businessName: slugA, city: "Manila" });

    const cookiesB = await pageB.context().cookies();
    const asB = await request.get(`${API_URL}/rpc/growth/leads`, {
      headers: {
        cookie: cookiesB.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-tenant-slug": slugB,
      },
    });
    expect(asB.status()).toBe(200);
    const bodyB = (await asB.json()) as { items: unknown[]; meta: { totalItems: number } };
    expect(bodyB.items.length, "business B must NEVER see a lead naming business A").toBe(0);
    expect(bodyB.meta.totalItems).toBe(0);

    await ctxB.close();
  });
});
