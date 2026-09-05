import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Hardening coverage for the member-initiated wallet/credit/payment mutation
 * surface (`.ai/plans/chrono/active/member-wallet-operation-hardening/README.md`):
 * the CSRF-preflight header (`x-member-action`) and the optional
 * `Idempotency-Key` replay protection layered on top of the already-covered
 * happy-path/role-gate/isolation behavior in `online-checkout.spec.ts`,
 * `wallet-history.spec.ts`, and `promos.spec.ts` — none of which this plan
 * touches.
 *
 * `/portal/payments/checkout`'s full replay round trip needs a real PSP call
 * once a `customerPayment` gateway is configured — this dev environment has
 * no real PayMongo credentials, the same constraint `online-checkout.spec.ts`
 * already documents at its file header. So checkout only gets its
 * header-rejection case here (which never reaches gateway resolution); its
 * full replay behavior (stubbed gateway) is covered by
 * `apps/chrono-api/src/modules/payment/portal-routes.test.ts`.
 * `/portal/credits/purchase` has no external dependency at all — its full
 * replay round trip IS driven for real below.
 */
const PASSWORD = "Password123!";
// Same host-mismatch reasoning as `online-checkout.spec.ts`'s own comment.
const apiUrl = "http://api.localtest.me:8787";

function xff(tag: string): string {
  return `e2e-wallethardening-${tag}`;
}

/** Route every request this `page` sends to the API host through a synthetic
 * `x-forwarded-for` so this spec's traffic never shares a rate-limit bucket
 * with any other concurrent run against this shared dev server. */
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

/** Mirrors `online-checkout.spec.ts`'s own helper — `/portal/auth/me` returns
 * the raw `MemberContext` shape (`memberId`, not `id`) unconditionally on
 * session, unlike `/portal/members/me` which needs an explicit apply step. */
async function getMemberIdentity(
  page: Page,
  slug: string,
  tag: string,
): Promise<{ memberId: string; tenantId: string }> {
  const res = await page.request.get(`${apiUrl}/portal/auth/me`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { member: { memberId: string; tenantId: string } };
  return { memberId: body.member.memberId, tenantId: body.member.tenantId };
}

/** Staff-side: creates a credit product and activates it in one helper —
 * `POST /rpc/credits/products` always creates as `"draft"`; the member
 * portal catalog only lists `"active"` products. */
async function createActiveCreditProduct(
  page: Page,
  slug: string,
  tag: string,
  args: { code: string; quantityMinutes: number; priceAmount: string },
): Promise<string> {
  const created = await page.request.post(`${apiUrl}/rpc/credits/products`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: {
      name: `Hardening Pack ${args.code}`,
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

/** Staff-side wallet top-up, so the member has enough balance to buy without
 * needing a real online payment. */
async function creditMemberWallet(
  page: Page,
  slug: string,
  tag: string,
  args: { memberId: string; amount: string },
) {
  const res = await page.request.post(`${apiUrl}/rpc/wallets/${args.memberId}/credit`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: { amount: args.amount, reason: "e2e seed" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.describe("Member wallet operation hardening", () => {
  test.describe.configure({ timeout: 270_000 });

  test("checkout: missing x-member-action header is rejected (400) before any gateway/DB work", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewophdrck${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Hardening Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await memberSignUp(page, base, { name: "Hardening Member", email: memberEmail });

    // No customerPayment gateway configured for this fresh tenant either —
    // proving the exact message distinguishes "missing header" from a
    // would-also-be-400 "gateway not configured" so this test proves the
    // NEW guard fired, not some other pre-existing 400 path.
    const res = await page.request.post(`${apiUrl}/portal/payments/checkout`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
      data: { purpose: "wallet_topup", amount: "50.00" },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing required header.");
  });

  test("purchase: missing x-member-action header is rejected (400) before any DB work", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewophdrpu${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Hardening Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await memberSignUp(page, base, { name: "Hardening Member", email: memberEmail });

    // A syntactically valid but non-existent productId — Zod only checks
    // non-empty; existence is a later DB lookup this test never reaches.
    const res = await page.request.post(`${apiUrl}/portal/credits/purchase`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
      data: { productId: faker.string.uuid() },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing required header.");
  });

  test("purchase: a replayed Idempotency-Key returns the ORIGINAL purchase/grant with no second wallet debit; a different key still debits again", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewophdrid${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    // Owner stays signed in on `page` for the staff-side seed calls.
    await signUpBusiness(page, { name: "Idem Owner", email: ownerEmail, slug });
    const productId = await createActiveCreditProduct(page, slug, uniq, {
      code: `HARD${uniq}`,
      quantityMinutes: 60,
      priceAmount: "30.00",
    });

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await isolateClientIp(pageMember, uniq);
    await memberSignUp(pageMember, base, { name: "Idem Member", email: memberEmail });
    const { memberId } = await getMemberIdentity(pageMember, slug, uniq);
    await creditMemberWallet(page, slug, uniq, { memberId, amount: "100.00" });

    const headers = { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq), "x-member-action": "1" };

    const idemKey = faker.string.uuid();
    const first = await pageMember.request.post(`${apiUrl}/portal/credits/purchase`, {
      headers: { ...headers, "Idempotency-Key": idemKey },
      data: { productId },
    });
    expect(first.status(), await first.text()).toBe(201);
    const firstBody = (await first.json()) as { purchase: { id: string }; grant: { id: string } };

    const replay = await pageMember.request.post(`${apiUrl}/portal/credits/purchase`, {
      headers: { ...headers, "Idempotency-Key": idemKey },
      data: { productId },
    });
    expect(replay.status(), await replay.text()).toBe(200);
    const replayBody = (await replay.json()) as { purchase: { id: string }; grant: { id: string } };
    expect(replayBody.purchase.id).toBe(firstBody.purchase.id);
    expect(replayBody.grant.id).toBe(firstBody.grant.id);

    const afterReplayBalance = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const { balance: balanceAfterReplay } = (await afterReplayBalance.json()) as { balance: string };
    // Debited exactly once: 100.00 - 30.00 = 70.00, not 40.00.
    expect(Number(balanceAfterReplay)).toBeCloseTo(70, 2);

    // A DIFFERENT key is a genuinely new purchase, not suppressed by the
    // first one's dedup — the fix must not over-suppress legitimate repeats.
    const second = await pageMember.request.post(`${apiUrl}/portal/credits/purchase`, {
      headers: { ...headers, "Idempotency-Key": faker.string.uuid() },
      data: { productId },
    });
    expect(second.status(), await second.text()).toBe(201);
    const secondBody = (await second.json()) as { purchase: { id: string } };
    expect(secondBody.purchase.id).not.toBe(firstBody.purchase.id);

    const finalBalance = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const { balance } = (await finalBalance.json()) as { balance: string };
    expect(Number(balance)).toBeCloseTo(40, 2);

    await ctxMember.close();
  });
});
