import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * STALE (centralized-webhook-architecture plan, Phase 6): the API route this
 * spec posts to (`POST /payments/customer/webhook/:token`) was deleted —
 * inbound PayMongo customer-payment webhooks now go through the centralized
 * ingress at a single stable `/api/v1/webhooks/paymongo` URL (no per-tenant
 * URL token at all; the tenant is identified by brute-force-matching the
 * request's HMAC signature against every enabled tenant's own secret — see
 * `apps/chrono-api/src/modules/webhook/adapters/paymongo.ts`). This file was
 * left unmodified rather than guessed at: the "isolation" test's whole premise
 * (a URL-token tenant vs. a payload-metadata tenant mismatching) no longer
 * applies under the new model, where the verified secret alone decides
 * identity — the equivalent guarantee ("a payload signed with tenant A's real
 * secret resolves to tenant A regardless of what its metadata claims") is
 * already proven at the adapter level by
 * `apps/chrono-api/src/modules/webhook/adapters/paymongo.test.ts`'s
 * "Mismatched metadata" case. This browser-level spec needs a real redesign,
 * not a URL swap, before it will pass again.
 */

/**
 * Member online checkout (`/member/wallet` top-up, `/member/promos/[id]`
 * "Buy online") — `.ai/plans/chrono/active/member-credit-purchase/README.md`,
 * Phase C6, the follow-up pass once the Phase C5 web UI landed.
 *
 * Fulfilment is webhook-only (the plan's central rule), so — like the
 * existing `billing/paymongo-checkout.spec.ts` precedent in this same
 * repo — this suite never drives a real `checkout.paymongo.com` round trip
 * (that needs a real `PAYMONGO_SECRET_KEY`, which this dev environment does
 * not have). Instead:
 *   - the "no gateway configured" disabled state is driven for real, through
 *     the browser, since it needs no external network call;
 *   - the happy path / replay / isolation cases configure a
 *     `customerPayment` integration with a webhook secret THIS TEST CHOOSES
 *     (via `PUT /rpc/integrations/customer-payment`, which never validates
 *     the API key against the real PSP), create the pending payment
 *     directly via the staff `POST /rpc/payments` endpoint (bypassing the
 *     member checkout route, which would otherwise call the real gateway),
 *     and then simulate PayMongo's own webhook delivery with a correctly
 *     HMAC-signed payload — exactly the "webhook-simulated fulfilment" the
 *     plan calls for. The HMAC scheme mirrors
 *     `verifyPaymongoSignature` (`packages/agora/src/commerce/billing/vendors/paymongo.ts`)
 *     verbatim: `t=<unixSeconds>,te=<hmac-sha256-hex of "t.payload">`.
 *
 * Rate-limit isolation: `clientIp()` (`packages/agora/src/core/server/
 * rate-limit.ts`) reads `x-forwarded-for`, else `x-real-ip`, else the literal
 * string `"unknown"` — and a real browser never sets `x-forwarded-for`
 * itself, so EVERY signup/login/checkout attempt from every concurrent
 * Playwright run against this shared local dev server (this spec, other
 * specs, other agents' sessions) piles into that one `"unknown"` bucket.
 * Every request this spec makes — both real page-driven ones (via
 * `isolateClientIp`'s route interception) and this spec's own raw
 * `page.request.*` calls (via the `xff` header below) — carries a
 * per-test-run synthetic `x-forwarded-for`, giving this spec's traffic its
 * own private rate-limit bucket independent of anything else hitting the
 * same dev server. No server restart, no waiting out someone else's quota.
 */
const PASSWORD = "Password123!";
// Matches `billing/paymongo-checkout.spec.ts`'s own convention in this
// directory — the auth cookie Better Auth's client sets is scoped to
// whatever host the browser bundle's `NEXT_PUBLIC_API_URL` resolves to at
// dev-server runtime (`api.localtest.me:8787` in this repo's local setup);
// `process.env.NEXT_PUBLIC_API_URL` read from the Playwright Node process
// is not guaranteed to match that (it depends on the invoking shell), so a
// mismatched default here would 401 every direct-to-API call with a stale
// "Not authenticated" from a cookie set on a different origin.
const apiUrl = "http://api.localtest.me:8787";

function xff(tag: string): string {
  return `e2e-checkout-${tag}`;
}

/** Route every request this `page` sends to the API host through a
 * synthetic `x-forwarded-for` — see the file-level comment above. Call once
 * per `Page`, including one created via `browser.newContext()`. */
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

/** The member's own `tenantMember` id + tenant id — needed to create a
 * staff-side payment row for this member and to stamp the webhook metadata.
 * `/portal/members/me` returns `profile: null` until the member explicitly
 * applies (`POST /portal/members/apply`, a separate step from sign-up) — so
 * this reads `/portal/auth/me` instead, which returns the `tenantMember` row
 * unconditionally on session. NOTE: this route returns the raw
 * `MemberContext` shape (`packages/agora/src/identity/member-auth/index.ts`,
 * `.get("/me", ...)`) — `{ memberId, tenantId, email, name, customerId }` —
 * NOT the `{ id, tenantId, email, name }` shape the client's own `MemberUser`
 * type claims (that type only matches sign-up/sign-in/accept-invite, which
 * map through `toMember()`; this one doesn't). Read `memberId`, not `id`. */
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

/** Configures a `customerPayment` integration with a webhook secret THIS
 * TEST chooses (never validated against the real PSP at configure time —
 * only `createCheckout` would ever call PayMongo, which this suite never
 * does). Staff-authed `page` must already be on the tenant's own host. */
async function configureCustomerPaymentGateway(
  page: Page,
  slug: string,
  tag: string,
  webhookSecret: string,
): Promise<{ webhookToken: string }> {
  const res = await page.request.put(`${apiUrl}/rpc/integrations/customer-payment`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: {
      provider: "paymongo",
      apiKey: `sk_test_${faker.string.alphanumeric(24)}`,
      webhookSecret,
      currency: "php",
      enabled: true,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { webhookReveal?: { webhookToken: string } };
  expect(body.webhookReveal).toBeTruthy();
  return { webhookToken: body.webhookReveal!.webhookToken };
}

/** Creates a `pending` `online` payment for a member directly via the staff
 * payments endpoint — bypasses `/portal/payments/checkout`, which would
 * otherwise call the real (unconfigured) PayMongo API. */
async function createPendingPayment(
  page: Page,
  slug: string,
  tag: string,
  args: { memberId: string; amount: string; currency?: string },
): Promise<string> {
  const res = await page.request.post(`${apiUrl}/rpc/payments`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
    data: {
      memberId: args.memberId,
      amount: args.amount,
      currency: args.currency ?? "PHP",
      method: "online",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { payment: { id: string } };
  return body.payment.id;
}

function amountToMinorUnits(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** `t=<unixSeconds>,te=<hmac-sha256-hex>` — mirrors `verifyPaymongoSignature`
 * (`packages/agora/src/commerce/billing/vendors/paymongo.ts`) exactly. */
function signPaymongoPayload(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},te=${sig}`;
}

/** A `checkout_session.payment.paid` event body, shaped exactly as
 * `parsePaymongoCustomerPayment` (`packages/agora/src/commerce/customer-payments/
 * vendors/paymongo.ts`) expects. */
function buildPaidEventPayload(opts: {
  eventId: string;
  tenantId: string;
  referenceId: string;
  amount: string;
  currency: string;
}): string {
  return JSON.stringify({
    data: {
      id: opts.eventId,
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        created_at: Math.floor(Date.now() / 1000),
        data: {
          id: `cs_test_${opts.eventId}`,
          attributes: {
            metadata: { tenantId: opts.tenantId, referenceId: opts.referenceId },
            payments: [
              {
                attributes: {
                  amount: amountToMinorUnits(opts.amount),
                  currency: opts.currency,
                },
              },
            ],
          },
        },
      },
    },
  });
}

/** The webhook is unauthenticated (no session, no `x-tenant-slug`) — it
 * still gets the `x-forwarded-for` isolation since it is itself rate-limited
 * (120/min per IP, `customerPaymentWebhookLimiter` in `app.ts`). */
async function postWebhook(
  page: Page,
  webhookToken: string,
  tag: string,
  payload: string,
  secret: string,
) {
  return page.request.post(`${apiUrl}/payments/customer/webhook/${webhookToken}`, {
    headers: {
      "content-type": "application/json",
      "paymongo-signature": signPaymongoPayload(payload, secret),
      "x-forwarded-for": xff(tag),
    },
    data: payload,
  });
}

test.describe("Member online checkout (PayMongo)", () => {
  test.describe.configure({ timeout: 270_000 });

  test("no gateway configured: wallet top-up renders disabled with honest copy", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eckoutgw${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Checkout Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Checkout Member", email: memberEmail });
    await page.getByTestId("member-nav-wallet").click();
    await expect(page).toHaveURL(`${base}/member/wallet`);

    // A fresh tenant has no `customerPayment` integration by default (never
    // seeded) — the buy button must be disabled, never broken, with honest
    // counter-staff copy.
    await expect(page.getByTestId("topup-button")).toBeDisabled();
    await expect(page.getByText("Ask staff at the counter to add credits.")).toBeVisible();
  });

  test("gate: an anonymous visitor is redirected off /member/wallet; a member cannot poll another member's payment (404)", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eckoutgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberAEmail = faker.internet.email({ provider: "example.com" });
    const memberBEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);

    // Anonymous → redirected to /login (client-side, MemberGate).
    await page.goto(`${base}/member/wallet`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    // The owner stays signed in on `page` for the rest of this test — the
    // staff `POST /rpc/payments` call below needs that session, so it is
    // never signed out (unlike the other specs in this file that reuse
    // `page` as the member afterward).
    await signUpBusiness(page, { name: "Gate Owner", email: ownerEmail, slug });

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await isolateClientIp(pageA, uniq);
    await memberSignUp(pageA, base, { name: "Member A", email: memberAEmail });
    const { memberId: memberAId } = await getMemberIdentity(pageA, slug, uniq);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await isolateClientIp(pageB, uniq);
    await memberSignUp(pageB, base, { name: "Member B", email: memberBEmail });

    // Owner creates a pending payment for Member A.
    const paymentAId = await createPendingPayment(page, slug, uniq, {
      memberId: memberAId,
      amount: "15.00",
    });

    // Member A can read their own payment.
    const ownRes = await pageA.request.get(`${apiUrl}/portal/payments/${paymentAId}`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    expect(ownRes.status(), await ownRes.text()).toBe(200);

    // Member B polling Member A's payment id 404s — not 403 (no existence leak).
    const crossRes = await pageB.request.get(`${apiUrl}/portal/payments/${paymentAId}`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    expect(crossRes.status()).toBe(404);

    await ctxA.close();
    await ctxB.close();
  });

  test("happy path + replay: the webhook fulfils a pending payment once; a duplicate delivery is a no-op", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eckouthappy${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const webhookSecret = `whsec_${faker.string.alphanumeric(32)}`;
    const amount = "75.00";

    await isolateClientIp(page, uniq);

    // The owner stays signed in on `page` for the whole test — the staff
    // `POST /rpc/payments` call needs that session. The member gets its own
    // browser context.
    await signUpBusiness(page, { name: "Happy Owner", email: ownerEmail, slug });
    const { webhookToken } = await configureCustomerPaymentGateway(page, slug, uniq, webhookSecret);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await isolateClientIp(pageMember, uniq);
    await memberSignUp(pageMember, base, { name: "Happy Member", email: memberEmail });

    // Now that a gateway is configured, the top-up button is enabled.
    await pageMember.getByTestId("member-nav-wallet").click();
    await expect(pageMember.getByTestId("topup-button")).toBeEnabled();

    const { memberId, tenantId } = await getMemberIdentity(pageMember, slug, uniq);
    const paymentId = await createPendingPayment(page, slug, uniq, { memberId, amount });

    // The return/poll banner never claims success on its own — it reflects
    // the still-pending payment honestly.
    await pageMember.goto(`${base}/member/wallet?payment=${paymentId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(pageMember.getByTestId("payment-status-card")).toContainText(
      "Payment received — credits are being added.",
    );

    // The balance BEFORE fulfilment, to prove the credit lands exactly once.
    const beforeRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const before = (await beforeRes.json()) as { balance: string };

    const eventId = faker.string.uuid();
    const payload = buildPaidEventPayload({
      eventId,
      tenantId,
      referenceId: paymentId,
      amount,
      currency: "PHP",
    });

    const firstWebhook = await postWebhook(pageMember, webhookToken, uniq, payload, webhookSecret);
    expect(firstWebhook.ok(), await firstWebhook.text()).toBeTruthy();

    await pageMember.reload();
    await expect(pageMember.getByTestId("payment-status-card")).toContainText("Payment successful", {
      timeout: 20_000,
    });

    const afterRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const after = (await afterRes.json()) as { balance: string };
    expect(Number(after.balance)).toBeCloseTo(Number(before.balance) + Number(amount), 2);

    // Replay: PayMongo redelivering the SAME event id is a no-op.
    const replay = await postWebhook(pageMember, webhookToken, uniq, payload, webhookSecret);
    expect(replay.ok(), await replay.text()).toBeTruthy();
    const replayBody = (await replay.json()) as { deduped?: boolean };
    expect(replayBody.deduped).toBe(true);

    const finalRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const final = (await finalRes.json()) as { balance: string };
    // Credited once, not twice.
    expect(Number(final.balance)).toBeCloseTo(Number(after.balance), 2);

    await ctxMember.close();
  });

  test("isolation: a webhook resolved to tenant B cannot fulfil tenant A's payment", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2eckoutisoa${uniq}`;
    const slugB = `e2eckoutisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const secretA = `whsec_${faker.string.alphanumeric(32)}`;
    const secretB = `whsec_${faker.string.alphanumeric(32)}`;
    const amount = "42.00";

    await isolateClientIp(page, uniq);

    // Owner A stays signed in on `page` for the whole test — the staff
    // `POST /rpc/payments` call needs that session.
    await signUpBusiness(page, { name: "Iso Owner A", email: emailA, slug: slugA });
    const { webhookToken: tokenA } = await configureCustomerPaymentGateway(
      page,
      slugA,
      uniq,
      secretA,
    );

    const ctxMemberA = await browser.newContext();
    const pageMemberA = await ctxMemberA.newPage();
    await isolateClientIp(pageMemberA, uniq);
    await memberSignUp(pageMemberA, baseA, { name: "Iso Member A", email: memberEmailA });
    const { memberId: memberAId, tenantId: tenantAId } = await getMemberIdentity(
      pageMemberA,
      slugA,
      uniq,
    );

    const paymentAId = await createPendingPayment(page, slugA, uniq, {
      memberId: memberAId,
      amount,
    });

    const ctxOwnerB = await browser.newContext();
    const pageOwnerB = await ctxOwnerB.newPage();
    await isolateClientIp(pageOwnerB, uniq);
    await signUpBusiness(pageOwnerB, { name: "Iso Owner B", email: emailB, slug: slugB });
    const { webhookToken: tokenB } = await configureCustomerPaymentGateway(
      pageOwnerB,
      slugB,
      uniq,
      secretB,
    );

    // An attacker (or a misdirected retry) carries tenant A's real payment
    // id into tenant B's own webhook token, signed with tenant B's own real
    // secret. The path-resolved tenant (B, from the token) never matches the
    // payload's own tenantId (A) — refused before any fulfilment runs.
    const eventId = faker.string.uuid();
    const forgedPayload = buildPaidEventPayload({
      eventId,
      tenantId: tenantAId,
      referenceId: paymentAId,
      amount,
      currency: "PHP",
    });
    const crossRes = await postWebhook(pageOwnerB, tokenB, uniq, forgedPayload, secretB);
    expect(crossRes.status()).toBe(400);

    // Tenant A's payment was never touched by the refused cross-tenant call.
    const stillPending = await pageMemberA.request.get(`${apiUrl}/portal/payments/${paymentAId}`, {
      headers: { "x-tenant-slug": slugA, "x-forwarded-for": xff(uniq) },
    });
    const stillPendingBody = (await stillPending.json()) as { status: string };
    expect(stillPendingBody.status).toBe("pending");

    // tokenA is exercised only to prove it's a distinct, valid token for
    // tenant A (never used above, since the attack targets tenant B's URL).
    expect(tokenA).not.toBe(tokenB);

    await ctxMemberA.close();
    await ctxOwnerB.close();
  });
});
