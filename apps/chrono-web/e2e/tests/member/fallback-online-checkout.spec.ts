import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Platform-level PayMongo fallback for member online checkout —
 * `.ai/plans/agora/in-progress/platform-paymongo-customer-payment-fallback/README.md`,
 * Phase 6. This is the sibling of `online-checkout.spec.ts` (read that file's
 * own header first — same conventions, same rate-limit isolation trick).
 *
 * **Why this suite never drives the actual member "Buy" flow for the
 * fallback path.** `ChronoPayments.gatewayScope` is written ONLY by
 * `POST /portal/payments/checkout` (`apps/chrono-api/src/modules/payment/
 * portal-routes.ts`), which calls `gateway.createCheckout(...)` for real —
 * for the platform gateway that means a genuine outbound call to PayMongo's
 * API using `PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_SECRET_KEY`. Exactly like
 * `online-checkout.spec.ts` already documents for the TENANT gateway, this
 * repo's e2e suite has no real PayMongo credentials to spend, so it never
 * calls `createCheckout`. That means a browser-driven `gatewayScope="platform"`
 * assertion is not achievable here — it would require either a real
 * `sk_test_...` platform key (an external dependency this suite doesn't
 * carry) or a Node-level stub of `resolveCustomerPaymentGateway`
 * (`__setCustomerPaymentGateway`, exercised in
 * `apps/chrono-api/src/modules/payment/portal-routes.test.ts`, which never
 * asserted the resulting `gatewayScope` column value for either scope at the
 * time this suite was written — a gap worth closing there, not here).
 *
 * What THIS suite proves instead, deterministically, with no external PSP
 * dependency: the shared platform webhook route
 * (`POST /payments/customer/webhook/platform`, mounted in `app.ts`) is
 * correctly wired end-to-end through the REAL running `chrono-api` process —
 * `payment-bootstrap.ts`'s `registerCustomerPaymentFulfilment("chrono_payment", ...)`
 * actually fires, the wallet is credited exactly once even under replay, and
 * the existing PER-TENANT flow (a tenant with its own configured gateway) is
 * completely unaffected by the new route/registry existing alongside it.
 * Signature verification is pure local HMAC — no PayMongo network call is
 * needed for the webhook side, only for checkout creation, so this is a
 * legitimate, non-flaky, offline-capable proof of the Phase 3/4 wiring.
 *
 * The fallback test below needs
 * `PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_WEBHOOK_SECRET` to be set to the SAME
 * value in the running `chrono-api` process's environment — it is skipped
 * (not silently passed) when this Playwright process doesn't have that value
 * itself, since there is no test-settable seam for the platform secret (unlike
 * the tenant-configured one, which the test can freely choose via
 * `PUT /rpc/integrations/customer-payment`).
 */
const PASSWORD = "Password123!";
const apiUrl = "http://api.localtest.me:8787";
const PLATFORM_WEBHOOK_SECRET = process.env.PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_WEBHOOK_SECRET;

function xff(tag: string): string {
  return `e2e-fallback-checkout-${tag}`;
}

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

/** Same shape/caveats as `online-checkout.spec.ts`'s own helper. */
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

/** Configures a `customerPayment` integration with a webhook secret THIS TEST
 * chooses — used only by the regression case below (a tenant WITH its own
 * gateway), never by the fallback case (the platform secret is not
 * tenant-configurable). Mirrors `online-checkout.spec.ts` exactly. */
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
 * payments endpoint — bypasses `/portal/payments/checkout` (and therefore
 * never touches `gatewayScope`, which stays at its DB default, `"tenant"`,
 * on every row created this way — see the file-level comment above). */
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

/** Staff read of a single payment (includes `gatewayScope`, which the
 * member-facing `GET /portal/payments/:id` DTO deliberately omits). */
async function getStaffPayment(
  page: Page,
  slug: string,
  tag: string,
  paymentId: string,
): Promise<{ gatewayScope: string; status: string }> {
  const res = await page.request.get(`${apiUrl}/rpc/payments/${paymentId}`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { payment: { gatewayScope: string; status: string } };
  return body.payment;
}

function amountToMinorUnits(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** `t=<unixSeconds>,te=<hmac-sha256-hex>` — mirrors `verifyPaymongoSignature`
 * exactly, same as `online-checkout.spec.ts`'s own signer. */
function signPaymongoPayload(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},te=${sig}`;
}

/** A `checkout_session.payment.paid` event body carrying the extra
 * `referenceType` metadata field the shared PLATFORM route requires (the
 * per-tenant route infers it implicitly since only Chrono payments ever flow
 * through a tenant's own token) — see
 * `packages/agora/src/commerce/customer-payments/platform-webhook-route.test.ts`'s
 * own fixture, which this mirrors. */
function buildPaidEventPayload(opts: {
  eventId: string;
  tenantId: string;
  referenceId: string;
  referenceType?: string;
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
            metadata: {
              tenantId: opts.tenantId,
              referenceId: opts.referenceId,
              ...(opts.referenceType !== undefined ? { referenceType: opts.referenceType } : {}),
            },
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

async function postTenantWebhook(
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

async function postPlatformWebhook(page: Page, tag: string, payload: string, secret: string) {
  return page.request.post(`${apiUrl}/payments/customer/webhook/platform`, {
    headers: {
      "content-type": "application/json",
      "paymongo-signature": signPaymongoPayload(payload, secret),
      "x-forwarded-for": xff(tag),
    },
    data: payload,
  });
}

test.describe("Member online checkout: platform PayMongo fallback", () => {
  test.describe.configure({ timeout: 270_000 });

  test("no gateway anywhere: wallet top-up still renders disabled with honest copy", async ({
    page,
  }) => {
    // `GET /portal/payments/gateway` reports `available` off the TENANT's own
    // `customerPayment` integration row only — it does not consult the
    // platform fallback (see the file-level comment above) — so a tenant with
    // no integration configured must still show the disabled state exactly as
    // before this plan, regardless of whether the platform fallback itself is
    // configured on the server.
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2efbgw${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Fallback Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Fallback Member", email: memberEmail });
    await page.getByTestId("member-nav-wallet").click();
    await expect(page).toHaveURL(`${base}/member/wallet`);

    await expect(page.getByTestId("topup-button")).toBeDisabled();
    await expect(page.getByText("Ask staff at the counter to add credits.")).toBeVisible();
  });

  test("platform webhook: fulfils a pending payment for a tenant with no gateway configured; a duplicate delivery is a no-op", async ({
    page,
    browser,
  }) => {
    test.skip(
      !PLATFORM_WEBHOOK_SECRET,
      "PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_WEBHOOK_SECRET is not set in this Playwright " +
        "process — it must match the value configured for the running chrono-api dev " +
        "server for this spec to sign a webhook it will accept.",
    );

    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2efbhappy${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const amount = "60.00";

    await isolateClientIp(page, uniq);
    // The owner stays signed in on `page` for the staff `POST /rpc/payments`
    // and `GET /rpc/payments/:id` calls below — deliberately NEVER configures
    // a `customerPayment` integration for this tenant, so it has no gateway
    // of its own at all.
    await signUpBusiness(page, { name: "Fallback Happy Owner", email: ownerEmail, slug });

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await isolateClientIp(pageMember, uniq);
    await memberSignUp(pageMember, base, { name: "Fallback Happy Member", email: memberEmail });
    const { memberId, tenantId } = await getMemberIdentity(pageMember, slug, uniq);

    const paymentId = await createPendingPayment(page, slug, uniq, { memberId, amount });

    const beforeRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const before = (await beforeRes.json()) as { balance: string };

    const eventId = faker.string.uuid();
    const payload = buildPaidEventPayload({
      eventId,
      tenantId,
      referenceId: paymentId,
      referenceType: "chrono_payment",
      amount,
      currency: "PHP",
    });

    const firstWebhook = await postPlatformWebhook(page, uniq, payload, PLATFORM_WEBHOOK_SECRET!);
    expect(firstWebhook.ok(), await firstWebhook.text()).toBeTruthy();
    const firstBody = (await firstWebhook.json()) as { received: boolean; ignored?: boolean };
    expect(firstBody.received).toBe(true);
    expect(firstBody.ignored).toBeFalsy();

    const afterRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const after = (await afterRes.json()) as { balance: string };
    expect(Number(after.balance)).toBeCloseTo(Number(before.balance) + Number(amount), 2);

    const staffPaymentAfter = await getStaffPayment(page, slug, uniq, paymentId);
    expect(staffPaymentAfter.status).toBe("paid");

    // Replay: PayMongo redelivering the SAME event is a no-op — the wallet is
    // credited exactly once (fulfilCustomerPayment's own `already_paid` guard),
    // and the response never claims a second fulfilment.
    const replay = await postPlatformWebhook(page, uniq, payload, PLATFORM_WEBHOOK_SECRET!);
    expect(replay.ok(), await replay.text()).toBeTruthy();

    const finalRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const final = (await finalRes.json()) as { balance: string };
    expect(Number(final.balance)).toBeCloseTo(Number(after.balance), 2);

    await ctxMember.close();
  });

  test("regression: a tenant with its own configured gateway is unaffected by the platform fallback existing", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2efbregress${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const webhookSecret = `whsec_${faker.string.alphanumeric(32)}`;
    const amount = "35.00";

    await isolateClientIp(page, uniq);
    await signUpBusiness(page, { name: "Fallback Regress Owner", email: ownerEmail, slug });
    const { webhookToken } = await configureCustomerPaymentGateway(page, slug, uniq, webhookSecret);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await isolateClientIp(pageMember, uniq);
    await memberSignUp(pageMember, base, { name: "Fallback Regress Member", email: memberEmail });
    await pageMember.getByTestId("member-nav-wallet").click();
    await expect(pageMember.getByTestId("topup-button")).toBeEnabled();

    const { memberId, tenantId } = await getMemberIdentity(pageMember, slug, uniq);
    const paymentId = await createPendingPayment(page, slug, uniq, { memberId, amount });

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

    // Delivered on the EXISTING per-tenant path, not the new platform one —
    // proves the two routes stay independent.
    const webhookRes = await postTenantWebhook(pageMember, webhookToken, uniq, payload, webhookSecret);
    expect(webhookRes.ok(), await webhookRes.text()).toBeTruthy();

    const afterRes = await pageMember.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(uniq) },
    });
    const after = (await afterRes.json()) as { balance: string };
    expect(Number(after.balance)).toBeCloseTo(Number(before.balance) + Number(amount), 2);

    // `gatewayScope` reads "tenant" — its DB default, since this payment was
    // created via the staff bypass rather than a real `/checkout` call (see
    // the file-level comment on why this suite cannot exercise that call for
    // real) — but this still proves the row this plan's new `gatewayScope`
    // column added is readable and did not disturb the existing tenant flow.
    const staffPayment = await getStaffPayment(page, slug, uniq, paymentId);
    expect(staffPayment.gatewayScope).toBe("tenant");
    expect(staffPayment.status).toBe("paid");

    await ctxMember.close();
  });
});
