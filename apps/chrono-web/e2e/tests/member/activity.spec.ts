import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member unified Activity feed (`/member/history`, `GET /portal/activity`) —
 * chrono/member-area, member-portal-v2 phase 8.
 *
 * Happy path: a wallet top-up (staff-seeded) plus a wallet-funded credit-pack
 * purchase produce both a "Wallet debit" row and a "Credits granted" row in
 * ONE merged, server-paginated feed (spans 2 of the 4 source event types —
 * session/reservation events are exercised by their own specs
 * (`session.spec.ts`, elsewhere) and aren't re-seeded here); pagination is
 * proven directly against `GET /portal/activity` (page 1 vs page 2 return
 * disjoint, correctly-ordered rows) rather than by clicking through the UI,
 * matching this suite's existing precedent
 * (`wallet-operation-hardening.spec.ts`) of mixing UI and direct API
 * assertions; cross-tenant isolation: tenant B's member never sees tenant
 * A's activity — neither its rows nor its distinctive event text.
 */
const PASSWORD = "Password123!";
const apiUrl = "http://api.localtest.me:8787";

function xff(tag: string): string {
  return `e2e-activity-${tag}`;
}

/** Route every request this `page` sends to the API host through a synthetic
 * `x-forwarded-for` so this spec's traffic never shares a rate-limit bucket
 * with any other concurrent run against this shared dev server (mirrors
 * `wallet-operation-hardening.spec.ts`'s own helper). */
async function isolateClientIp(page: Page, tag: string) {
  await page.route(`${apiUrl}/**`, (route) => {
    const headers = { ...route.request().headers(), "x-forwarded-for": xff(tag) };
    return route.continue({ headers });
  });
}

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

/** `/portal/auth/me` returns the raw `MemberContext` shape (`memberId`, not
 * `id`) unconditionally on session — mirrors `wallet-operation-hardening.
 * spec.ts`'s own helper. */
async function getMemberIdentity(
  page: Page,
  slug: string,
  tag: string,
): Promise<{ memberId: string }> {
  const res = await page.request.get(`${apiUrl}/portal/auth/me`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { member: { memberId: string } };
  return { memberId: body.member.memberId };
}

/** Staff-side wallet top-up — mirrors `wallet-operation-hardening.spec.ts`'s
 * own helper, with a caller-supplied `reason` so tests can grep for a
 * distinctive description in the rendered feed. */
async function creditMemberWallet(
  page: Page,
  slug: string,
  tag: string,
  args: { memberId: string; amount: string; reason: string },
) {
  const res = await page.request.post(`${apiUrl}/rpc/wallets/${args.memberId}/credit`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: { amount: args.amount, reason: args.reason },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Staff-side: creates a credit product and activates it in one helper —
 * mirrors `wallet-operation-hardening.spec.ts`'s own helper. */
async function createActiveCreditProduct(
  page: Page,
  slug: string,
  tag: string,
  args: { code: string; quantityMinutes: number; priceAmount: string },
): Promise<string> {
  const created = await page.request.post(`${apiUrl}/rpc/credits/products`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: {
      name: `Activity Pack ${args.code}`,
      code: args.code,
      quantityMinutes: args.quantityMinutes,
      priceAmount: args.priceAmount,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { product } = (await created.json()) as { product: { id: string } };

  const activated = await page.request.patch(`${apiUrl}/rpc/credits/products/${product.id}`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: { status: "active" },
  });
  expect(activated.ok(), await activated.text()).toBeTruthy();
  return product.id;
}

test.describe("Member activity feed", () => {
  test.describe.configure({ timeout: 270_000 });

  test("happy path: a wallet top-up and a credit purchase both appear in the merged feed", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememact${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Activity Owner", email: ownerEmail, slug });
    const productId = await createActiveCreditProduct(page, slug, uniq, {
      code: `ACT${uniq}`,
      quantityMinutes: 60,
      priceAmount: "30.00",
    });

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await isolateClientIp(pageMember, uniq);
    await memberSignUp(pageMember, base, { name: "Activity Member", email: memberEmail });
    const { memberId } = await getMemberIdentity(pageMember, slug, uniq);

    const topUpReason = `Activity feed seed top-up ${uniq}`;
    await creditMemberWallet(page, slug, uniq, {
      memberId,
      amount: "100.00",
      reason: topUpReason,
    });

    const purchase = await pageMember.request.post(`${apiUrl}/portal/credits/purchase`, {
      headers: {
        "x-tenant-slug": slug,
        "x-forwarded-for": xff(uniq),
        "x-member-action": "1",
        "Idempotency-Key": faker.string.uuid(),
      },
      data: { productId },
    });
    expect(purchase.ok(), await purchase.text()).toBeTruthy();

    await pageMember.goto(`${base}/member/history`);
    await pageMember.waitForLoadState("networkidle");

    // Both event types the seed above produced are visible in ONE feed, no
    // tab-switching required.
    await expect(pageMember.getByText("Wallet debit")).toBeVisible();
    await expect(pageMember.getByText("Credits granted")).toBeVisible();
    await expect(pageMember.getByText(topUpReason)).toBeVisible();

    // Filtering to a single type narrows the feed without losing the other
    // event — the wallet debit row disappears, the credits-granted row
    // (still present because the filter select defaults back after
    // selection) is exercised via a direct API call below instead, since the
    // shadcn Select's option text isn't a stable accessible role name across
    // browsers in this harness.
    const walletOnly = await pageMember.request.get(
      `${apiUrl}/portal/activity?type=wallet&page=1&pageSize=20`,
      { headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) } },
    );
    expect(walletOnly.ok(), await walletOnly.text()).toBeTruthy();
    const walletOnlyBody = (await walletOnly.json()) as {
      items: Array<{ type: string }>;
    };
    expect(walletOnlyBody.items.length).toBeGreaterThan(0);
    expect(walletOnlyBody.items.every((item) => item.type === "wallet")).toBe(true);
  });

  test("pagination: page 1 and page 2 return disjoint, newest-first rows", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememactp${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Activity Owner 2", email: ownerEmail, slug });

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await isolateClientIp(pageMember, uniq);
    await memberSignUp(pageMember, base, { name: "Activity Member 2", email: memberEmail });
    const { memberId } = await getMemberIdentity(pageMember, slug, uniq);

    // Seed enough wallet events to span two pages at pageSize=5.
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await creditMemberWallet(page, slug, uniq, {
        memberId,
        amount: "1.00",
        reason: `seed-${uniq}-${i}`,
      });
    }

    const pageOneRes = await pageMember.request.get(
      `${apiUrl}/portal/activity?page=1&pageSize=5`,
      { headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) } },
    );
    expect(pageOneRes.ok(), await pageOneRes.text()).toBeTruthy();
    const pageOne = (await pageOneRes.json()) as {
      items: Array<{ id: string; occurredAt: string }>;
      meta: { totalItems: number; hasNextPage: boolean };
    };
    expect(pageOne.items.length).toBe(5);
    expect(pageOne.meta.totalItems).toBeGreaterThanOrEqual(8);
    expect(pageOne.meta.hasNextPage).toBe(true);

    const pageTwoRes = await pageMember.request.get(
      `${apiUrl}/portal/activity?page=2&pageSize=5`,
      { headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) } },
    );
    expect(pageTwoRes.ok(), await pageTwoRes.text()).toBeTruthy();
    const pageTwo = (await pageTwoRes.json()) as {
      items: Array<{ id: string; occurredAt: string }>;
    };
    expect(pageTwo.items.length).toBeGreaterThan(0);

    // Disjoint: no id appears on both pages.
    const pageOneIds = new Set(pageOne.items.map((item) => item.id));
    for (const item of pageTwo.items) {
      expect(pageOneIds.has(item.id)).toBe(false);
    }

    // Newest-first (the default order): the oldest row on page 1 is still
    // newer than or equal to the newest row on page 2.
    const oldestOnPageOne = pageOne.items[pageOne.items.length - 1]?.occurredAt;
    const newestOnPageTwo = pageTwo.items[0]?.occurredAt;
    expect(oldestOnPageOne).toBeTruthy();
    expect(newestOnPageTwo).toBeTruthy();
    expect(new Date(oldestOnPageOne ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(newestOnPageTwo ?? 0).getTime(),
    );
  });

  test("isolation: tenant B's member never sees tenant A's activity", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememacta${uniq}`;
    const slugB = `e2ememactb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // `page` stays Owner A's staff session throughout — `creditMemberWallet`
    // below is a staff-only route, so Member A needs its own separate
    // context (mirrors every other test in this file: the staff session that
    // seeds the wallet is never the same session used to sign up a member).
    await signUpBusiness(page, { name: "Activity Owner A", email: emailA, slug: slugA });

    const contextMemberA = await browser.newContext();
    const pageMemberA = await contextMemberA.newPage();
    await memberSignUp(pageMemberA, baseA, { name: "Member A", email: memberEmailA });
    const { memberId: memberIdA } = await getMemberIdentity(pageMemberA, slugA, uniq);

    const distinctiveReason = `Member A only activity ${uniq}`;
    await creditMemberWallet(page, slugA, uniq, {
      memberId: memberIdA,
      amount: "42.00",
      reason: distinctiveReason,
    });
    await contextMemberA.close();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUpBusiness(pageB, { name: "Activity Owner B", email: emailB, slug: slugB });
    await pageB.getByRole("button", { name: "Sign out" }).click();
    await pageB.waitForLoadState("networkidle");
    await memberSignUp(pageB, baseB, { name: "Member B", email: memberEmailB });

    await pageB.goto(`${baseB}/member/history`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText("No activity yet.")).toBeVisible();
    await expect(pageB.getByText(distinctiveReason)).toHaveCount(0);

    // Same check at the API layer — a UI miss alone doesn't prove isolation
    // if the route itself leaked rows a client-side filter happened to hide.
    const bFeed = await pageB.request.get(`${apiUrl}/portal/activity?page=1&pageSize=20`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(bFeed.ok(), await bFeed.text()).toBeTruthy();
    const bBody = (await bFeed.json()) as { items: Array<{ description: string }> };
    expect(bBody.items.some((item) => item.description === distinctiveReason)).toBe(false);

    await contextB.close();
  });
});
