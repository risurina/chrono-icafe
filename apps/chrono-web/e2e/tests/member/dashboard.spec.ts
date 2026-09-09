import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member dashboard (`/member`) — chrono/member-area, execution phase 2.
 *
 * Happy path: dashboard cards render real (not mocked) data from the new
 * `/portal/loyalty/me`, `/portal/sessions/summary`, `/portal/wallet/balance`,
 * `/portal/wallet/history`, and `/portal/credits/products` reads, and the
 * manual Refresh button re-fetches; role check: Promos is NOT gated for an
 * unapproved (pending) applicant per the plan's decision (only the store
 * PURCHASE route is) — this asserts the dashboard itself, and the one other
 * page live in this phase (Reservations), render identically before
 * approval; cross-tenant isolation: tenant B's member dashboard never shows
 * tenant A's member's name or figures.
 *
 * member-lounge-richer-detail Phase 3 extends this same spec (per the plan's
 * own "extends the existing dashboard spec" out-of-scope note, not a new
 * file) to cover the Lounge's richer detail: the `Code: <memberCode>` badge
 * on the membership card and the `data-testid="time-credits-card"` grouped
 * by station group. That card is rendered for every signed-in member
 * (approved or not) — locked with a message when `!approved`, matching this
 * page's existing Wallet-card pattern — so the role-gate test asserts the
 * locked message rather than the card's absence.
 */
const PASSWORD = "Password123!";
// Same host-mismatch reasoning as other member-area specs (e.g.
// wallet-operation-hardening.spec.ts): direct API calls against the tenant
// subdomain host don't resolve the same way a browser navigation does, so
// staff/member API calls seeded here go straight to the API host with an
// explicit `x-tenant-slug` header instead.
const apiUrl = "http://api.localtest.me:8787";

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

/** Member applies (creates the `chronoMemberProfile` row, "pending") and
 * staff approves it from `/admin/members` — the ONLY path that assigns a
 * `memberCode` (`member/service.ts`'s `approveMemberProfile`; the
 * `chrono.autoApproveMembers` flag path on `/apply` does not generate one).
 * `memberPage` must already carry a signed-in tenant-member session (via
 * `memberSignUp`); `ownerPage` must already carry a signed-in staff session
 * for this tenant. */
async function applyAndApprove(
  memberPage: Page,
  ownerPage: Page,
  { slug, base, memberEmail }: { slug: string; base: string; memberEmail: string },
) {
  const applyRes = await memberPage.request.post(`${apiUrl}/portal/members/apply`, {
    headers: { "x-tenant-slug": slug },
    data: {},
  });
  expect(applyRes.ok(), await applyRes.text()).toBeTruthy();

  await ownerPage.goto(`${base}/admin/members`);
  await ownerPage.waitForLoadState("networkidle");
  const row = ownerPage.getByRole("row", { name: new RegExp(memberEmail) });
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(ownerPage.getByText("Application approved.")).toBeVisible();
}

/** Staff-side: creates a credit product and activates it in one helper —
 * `POST /rpc/credits/products` always creates as `"draft"`; the member
 * portal catalog only lists `"active"` products. Mirrors
 * `wallet-operation-hardening.spec.ts`'s own `createActiveCreditProduct`. */
async function createActiveCreditProduct(
  ownerPage: Page,
  slug: string,
  args: {
    code: string;
    quantityMinutes: number;
    priceAmount: string;
    stationGroupId?: string;
    creditPolicy?: "strict_group_only" | "any_station";
  },
): Promise<string> {
  const created = await ownerPage.request.post(`${apiUrl}/rpc/credits/products`, {
    headers: { "x-tenant-slug": slug },
    data: {
      name: `Lounge Pack ${args.code}`,
      code: args.code,
      quantityMinutes: args.quantityMinutes,
      priceAmount: args.priceAmount,
      ...(args.stationGroupId ? { stationGroupId: args.stationGroupId } : {}),
      ...(args.creditPolicy ? { creditPolicy: args.creditPolicy } : {}),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { product } = (await created.json()) as { product: { id: string } };

  const activated = await ownerPage.request.patch(`${apiUrl}/rpc/credits/products/${product.id}`, {
    headers: { "x-tenant-slug": slug },
    data: { status: "active" },
  });
  expect(activated.ok(), await activated.text()).toBeTruthy();
  return product.id;
}

/** Staff-side wallet top-up, so the member has enough balance to buy without
 * needing a real online payment. */
async function creditMemberWallet(
  ownerPage: Page,
  slug: string,
  args: { memberId: string; amount: string },
) {
  const res = await ownerPage.request.post(`${apiUrl}/rpc/wallets/${args.memberId}/credit`, {
    headers: { "x-tenant-slug": slug },
    data: { amount: args.amount, reason: "e2e seed" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function getMemberId(memberPage: Page, slug: string): Promise<string> {
  const res = await memberPage.request.get(`${apiUrl}/portal/auth/me`, {
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { member: { memberId: string } };
  return body.member.memberId;
}

async function purchaseCreditProduct(memberPage: Page, slug: string, productId: string) {
  const res = await memberPage.request.post(`${apiUrl}/portal/credits/purchase`, {
    headers: { "x-tenant-slug": slug, "x-member-action": "1" },
    data: { productId },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.describe("Member dashboard", () => {
  test.describe.configure({ timeout: 270_000 });

  test("happy path: dashboard cards render real data, Refresh re-fetches, and an approved member's purchased time credits + member code render", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememdash${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    // Owner stays signed in on its own context for the whole test — the
    // extension below needs concurrent owner (approve/seed) + member
    // (purchase) sessions, unlike the original single-`page` flow.
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await signUpBusiness(ownerPage, { name: "Dash Owner", email: ownerEmail, slug });

    await memberSignUp(page, base, { name: "Dash Member", email: memberEmail });

    // The hero/wallet/membership cards render for a brand-new member with no
    // history yet — real zero-state data (0m usage, ₱0.00 balance, bronze/0%
    // level), never a mock.
    await expect(page.getByTestId("playtime-hero")).toBeVisible();
    await expect(page.getByTestId("wallet-card")).toBeVisible();
    await expect(page.getByTestId("membership-card")).toBeVisible();
    await expect(page.getByTestId("premium-store")).toBeVisible();
    await expect(page.getByText(/Welcome, Dash Member/)).toBeVisible();
    await expect(page.getByText("bronze")).toBeVisible();

    // Manual Refresh re-fetches without polling (the plan's "no realtime for
    // members" decision) — clicking it must not error or navigate away.
    await page.getByTestId("member-refresh-button").click();
    await expect(page.getByTestId("playtime-hero")).toBeVisible();

    // --- member-lounge-richer-detail Phase 3 extension ---
    // Approve the member (assigns a `memberCode`), seed + purchase an
    // "any station" credit pack, then confirm the Lounge's Time Credits card
    // and the membership card's member-code badge both reflect real data.
    await applyAndApprove(page, ownerPage, { slug, base, memberEmail });

    const memberId = await getMemberId(page, slug);
    await creditMemberWallet(ownerPage, slug, { memberId, amount: "100.00" });
    const productId = await createActiveCreditProduct(ownerPage, slug, {
      code: `LOUNGE${uniq}`,
      quantityMinutes: 90,
      priceAmount: "50.00",
    });
    await purchaseCreditProduct(page, slug, productId);

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("time-credits-card")).toBeVisible();
    await expect(page.getByTestId("time-credits-card").getByText("Any station")).toBeVisible();
    await expect(page.getByTestId("time-credits-card").getByText("1h 30m")).toBeVisible();
    await expect(page.getByTestId("membership-card").getByText(/^Code: /)).toBeVisible();

    await ownerCtx.close();
  });

  test("a pending (unapproved) applicant still sees the dashboard and Reservations — only the store purchase is gated; time credits stay locked with no member code", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememdashp${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Pending Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Pending Member", email: memberEmail });

    await expect(page.getByTestId("playtime-hero")).toBeVisible();
    // No approval gate on the dashboard itself (only Promos/Leaderboard are
    // flagged) — Reservations is the one other page already live in this
    // phase (Wallet/Session/etc. land in later execution phases).
    await page.getByTestId("member-nav-reservations").click();
    await expect(page).toHaveURL(`${base}/member/reservations`);

    // member-lounge-richer-detail Phase 3: the Time Credits card renders for
    // every member (matching the existing Wallet-card pattern) but shows the
    // locked message, not real grant data, while unapproved — and the
    // membership card shows no member-code badge (none has been assigned
    // yet; a pending applicant's profile row has no `memberCode`).
    await page.goto(`${base}/member`);
    await expect(page.getByTestId("time-credits-card")).toBeVisible();
    await expect(
      page
        .getByTestId("time-credits-card")
        .getByText("Time credits unlock once your application is approved."),
    ).toBeVisible();
    await expect(page.getByTestId("membership-card").getByText(/^Code: /)).toHaveCount(0);
  });

  test("isolation: tenant B's member dashboard never shows tenant A's member's name or time-credit station-group names", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememdisoa${uniq}`;
    const slugB = `e2ememdisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Tenant A Owner", email: emailA, slug: slugA });
    const ctxA = await browser.newContext();
    const memberPageA = await ctxA.newPage();
    await memberSignUp(memberPageA, baseA, { name: "Isolation Member A", email: memberEmailA });
    await expect(memberPageA.getByText(/Welcome, Isolation Member A/)).toBeVisible();

    // Seed a named, station-group-scoped credit grant for tenant A's
    // member — this distinctive group name is the leak the isolation
    // assertion below checks for. `page` still holds tenant A's owner
    // session at this point (sign-out happens after this block).
    const groupNameA = `Tenant A VIP Room ${uniq}`;
    const branchRes = await page.request.post(`${apiUrl}/rpc/branches`, {
      headers: { "x-tenant-slug": slugA },
      data: { name: `Branch A ${uniq}` },
    });
    expect(branchRes.ok(), await branchRes.text()).toBeTruthy();
    const { branch } = (await branchRes.json()) as { branch: { id: string } };

    const groupRes = await page.request.post(`${apiUrl}/rpc/stations/groups`, {
      headers: { "x-tenant-slug": slugA },
      data: { branchId: branch.id, name: groupNameA, code: `VIPA${uniq}`, hourlyRate: 50 },
    });
    expect(groupRes.ok(), await groupRes.text()).toBeTruthy();
    const { stationGroup } = (await groupRes.json()) as { stationGroup: { id: string } };

    await applyAndApprove(memberPageA, page, { slug: slugA, base: baseA, memberEmail: memberEmailA });
    const memberIdA = await getMemberId(memberPageA, slugA);
    await creditMemberWallet(page, slugA, { memberId: memberIdA, amount: "50.00" });
    const productIdA = await createActiveCreditProduct(page, slugA, {
      code: `VIPPACK${uniq}`,
      quantityMinutes: 45,
      priceAmount: "20.00",
      stationGroupId: stationGroup.id,
      creditPolicy: "strict_group_only",
    });
    await purchaseCreditProduct(memberPageA, slugA, productIdA);

    await memberPageA.reload();
    await memberPageA.waitForLoadState("networkidle");
    await expect(memberPageA.getByTestId("time-credits-card").getByText(groupNameA)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // 2. Tenant B — a fresh tenant with no applicants of its own.
    await signUpBusiness(page, { name: "Tenant B Owner", email: emailB, slug: slugB });
    const ctxB = await browser.newContext();
    const memberPageB = await ctxB.newPage();
    await memberSignUp(memberPageB, baseB, { name: "Isolation Member B", email: memberEmailB });

    await expect(memberPageB.getByText(/Welcome, Isolation Member B/)).toBeVisible();
    await expect(memberPageB.getByText(/Isolation Member A/)).toHaveCount(0);

    // Tenant A's named station-group credit grant must never leak into
    // tenant B's Lounge — neither the rendered page nor the raw balance
    // response.
    await expect(memberPageB.getByText(groupNameA)).toHaveCount(0);
    const balanceB = await memberPageB.request.get(`${apiUrl}/portal/credits/balance`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(balanceB.ok(), await balanceB.text()).toBeTruthy();
    const balanceBBody = (await balanceB.json()) as {
      grants: Array<{ stationGroupName: string | null }>;
    };
    expect(balanceBBody.grants.some((g) => g.stationGroupName === groupNameA)).toBe(false);

    await ctxA.close();
    await ctxB.close();
  });
});
