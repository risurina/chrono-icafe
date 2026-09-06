import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Role gate for `GET /rpc/growth/demand`
 * (.ai/plans/chrono/in-progress/two-sided-growth-loop, Phase 7).
 *
 * `growth:read` is admin+ ONLY. That is the point of the resource: a demand
 * count is commercial/acquisition intelligence — the same tier as
 * `report:readFinancial` and `landingPage:manage` — not front-desk operational
 * data.
 *
 * This spec must FAIL if `growth: ["read"]` is ever added to
 * `CHRONO_STAFF_GRANTS`. It uses a REAL `staff` member (invited and accepted),
 * not a stripped custom role, so it asserts the actual staff/admin boundary
 * rather than deny-by-default plumbing — which `.ai/rules/rbac.md` rejects as
 * testing nothing.
 *
 * Mirrors `tenant-landing/edit-role-gate.spec.ts`, the closest existing
 * admin-only gate spec, including its console-driver invite-link helper.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
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

test.describe("Growth demand read — role gate", () => {
  test("owner reads the count; a real staff member is refused (403)", async ({
    page,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2egrowthgate${uniq}`;
    const staffSlug = `e2egrowthgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Growth Owner", email: ownerEmail, slug });

    // ── Owner (admin+): allowed. The count may legitimately be 0 — no lead
    //    names this brand-new business. What is asserted is the 200 and the
    //    response SHAPE.
    const ownerCookies = await page.context().cookies();
    const ownerHeaders = {
      cookie: ownerCookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-tenant-slug": slug,
    };
    // NB: the API is :8787, NOT the Next origin on :3000 — there is no /rpc
    // rewrite in next.config.ts, so a `${base}/rpc/...` call would hit Next and
    // 404. `base` stays correct for page.goto navigations below.
    const asOwner = await request.get(`${API_URL}/rpc/growth/demand`, {
      headers: ownerHeaders,
    });
    expect(asOwner.status()).toBe(200);
    const ownerBody = (await asOwner.json()) as Record<string, unknown>;
    expect(typeof ownerBody.count).toBe("number");
    // A bare count and nothing else — this route must never become a back-door
    // read of lead contents or requester identities.
    expect(Object.keys(ownerBody).sort()).toEqual(["count"]);

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

    // The invitee signs up for their own account, then accepts into `slug`
    // with the `staff` role.
    await signUp(page, { name: "Growth Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // ── Staff: refused. THE assertion this spec exists for. ──
    const staffCookies = await page.context().cookies();
    const asStaff = await request.get(`${API_URL}/rpc/growth/demand`, {
      headers: {
        cookie: staffCookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-tenant-slug": slug,
      },
    });
    expect(
      asStaff.status(),
      "staff must never read the demand count — growth:read is admin+ only",
    ).toBe(403);

    // ── And the banner it feeds is absent from the staff dashboard. A 403 is
    //    swallowed by design there, so this is "no banner", not "an error".
    await page.goto(`${base}/admin`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("growth-demand-banner")).toHaveCount(0);
  });
});
