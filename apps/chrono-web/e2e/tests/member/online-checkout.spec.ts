import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Redesigned for the centralized-webhook-architecture plan's Phase 6 cutover
 * (see `.ai/plans/chrono/in-progress/centralized-webhook-architecture.md`,
 * "Status" follow-up #2). Inbound PayMongo customer-payment webhooks now go
 * through the centralized ingress at a single stable
 * `POST /api/v1/webhooks/paymongo` URL, shared by every tenant — there is no
 * per-tenant URL token at all. Identity is proven by brute-force-matching the
 * request's HMAC signature against every enabled tenant's own configured
 * secret (plus the platform fallback secret); whichever secret produces a
 * matching signature is the verified tenant
 * (`apps/chrono-api/src/modules/webhook/adapters/paymongo.ts`,
 * `getCandidateSecrets()`/`resolve()`).
 *
 * The old "isolation" test asserted a URL-token-vs-payload-metadata mismatch
 * that no longer exists as a concept under this model. Its replacement below
 * asserts the actual guarantee that took its place: a payload signed with
 * tenant A's real secret, whose `metadata.tenantId` claims tenant B, still
 * resolves to and fulfils tenant A's payment — payload metadata is
 * informational only, never load-bearing for identity. This mirrors, at the
 * browser/HTTP level, `apps/chrono-api/src/modules/webhook/adapters/
 * paymongo.test.ts`'s "Mismatched tenant metadata" case (which signs with
 * `acmeId`'s real secret, claims `org_other` in `metadata.tenantId`, and
 * asserts the resulting `webhookEvent` row still resolves `scope: "tenant"`,
 * `tenantId: acmeId`).
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

/** A signed-in staff actor's own tenant id, via `GET /rpc/me` — used to get
 * tenant B's real id for the isolation test below without needing a member
 * account on tenant B (the owner's own staff session already carries it). */
async function getStaffTenantId(page: Page, slug: string, tag: string): Promise<string> {
  const res = await page.request.get(`${apiUrl}/rpc/me`, {
    headers: { "x-tenant-slug": slug, "x-forwarded-for": xff(tag) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { tenantId: string };
  return body.tenantId;
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
 * does). Staff-authed `page` must already be on the tenant's own host.
 *
 * The response's `webhookReveal.webhookUrl` is asserted to be the single,
 * stable, provider-wide ingress URL — every tenant configures the SAME URL
 * in their own PayMongo dashboard now (no more per-tenant `webhookToken` in
 * the URL; `customerPaymentWebhookUrl()`, `apps/chrono-api/src/routes/
 * rpc.ts`). Its host is whatever `AGORA_API_PUBLIC_URL` resolves to on the
 * running `chrono-api` process (not necessarily this Playwright process's own
 * `apiUrl`), so only the path is asserted. The reveal still carries a
 * `webhookToken` (vestigial — see this plan's Status follow-up #3 — the field
 * is no longer used to address the webhook route), which this helper
 * ignores. */
async function configureCustomerPaymentGateway(
  page: Page,
  slug: string,
  tag: string,
  webhookSecret: string,
): Promise<void> {
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
  const body = (await res.json()) as { webhookReveal?: { webhookUrl: string } };
  expect(body.webhookReveal).toBeTruthy();
  expect(body.webhookReveal!.webhookUrl).toMatch(/\/api\/v1\/webhooks\/paymongo$/);
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
 * still gets the `x-forwarded-for` isolation, and it still posts to the ONE
 * stable, provider-wide URL every tenant shares
 * (`POST /api/v1/webhooks/paymongo`, `agora/webhooks/inbound`'s
 * `webhookIngressRoutes()`, mounted in `apps/chrono-api/src/app.ts`). There is
 * no per-tenant token in the path anymore — the `secret` argument is what
 * proves which tenant this request belongs to. */
async function postWebhook(page: Page, tag: string, payload: string, secret: string) {
  return page.request.post(`${apiUrl}/api/v1/webhooks/paymongo`, {
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
    await configureCustomerPaymentGateway(page, slug, uniq, webhookSecret);

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

    const firstWebhook = await postWebhook(pageMember, uniq, payload, webhookSecret);
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
    const replay = await postWebhook(pageMember, uniq, payload, webhookSecret);
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

  test("isolation: a payload signed with tenant A's real secret resolves to tenant A, not the tenant its metadata claims (B)", async ({
    page,
    browser,
  }) => {
    // The new security property (centralized-webhook-architecture plan, Phase
    // 2 "Decided" list, point 8): `metadata.tenantId` is informational only,
    // never load-bearing for identity. There is one shared URL for every
    // tenant now, so the old "URL-token tenant vs. payload tenant mismatch →
    // reject" test no longer has anything to mismatch against — the only
    // thing that can prove identity is which tenant's secret produced a
    // valid HMAC. This drives that proof for real: tenant A's own secret,
    // tenant B's id forged into the payload, tenant A's own payment credited.
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
    await configureCustomerPaymentGateway(page, slugA, uniq, secretA);

    const ctxMemberA = await browser.newContext();
    const pageMemberA = await ctxMemberA.newPage();
    await isolateClientIp(pageMemberA, uniq);
    await memberSignUp(pageMemberA, baseA, { name: "Iso Member A", email: memberEmailA });
    const { memberId: memberAId } = await getMemberIdentity(pageMemberA, slugA, uniq);

    const paymentAId = await createPendingPayment(page, slugA, uniq, {
      memberId: memberAId,
      amount,
    });

    // Tenant B exists purely as the OTHER real tenant whose id gets forged
    // into the payload below — its own secret (`secretB`) is configured but
    // deliberately never used to sign anything in this test, proving the
    // attack succeeds (or fails) purely on whose secret verifies the
    // signature, never on which tenant merely exists or has its own gateway.
    const ctxOwnerB = await browser.newContext();
    const pageOwnerB = await ctxOwnerB.newPage();
    await isolateClientIp(pageOwnerB, uniq);
    await signUpBusiness(pageOwnerB, { name: "Iso Owner B", email: emailB, slug: slugB });
    await configureCustomerPaymentGateway(pageOwnerB, slugB, uniq, secretB);
    const tenantBId = await getStaffTenantId(pageOwnerB, slugB, uniq);

    const beforeRes = await pageMemberA.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slugA, "x-forwarded-for": xff(uniq) },
    });
    const before = (await beforeRes.json()) as { balance: string };

    // The forged payload: tenant A's real payment id as the reference, but
    // `metadata.tenantId` claims tenant B — yet it is signed with tenant A's
    // OWN real secret (`secretA`), posted to the single shared ingress URL.
    const eventId = faker.string.uuid();
    const forgedPayload = buildPaidEventPayload({
      eventId,
      tenantId: tenantBId,
      referenceId: paymentAId,
      amount,
      currency: "PHP",
    });
    const res = await postWebhook(pageOwnerB, uniq, forgedPayload, secretA);
    expect(res.ok(), await res.text()).toBeTruthy();

    // Resolved and fulfilled as TENANT A — despite the payload's own claim.
    const paidRes = await pageMemberA.request.get(`${apiUrl}/portal/payments/${paymentAId}`, {
      headers: { "x-tenant-slug": slugA, "x-forwarded-for": xff(uniq) },
    });
    const paidBody = (await paidRes.json()) as { status: string };
    expect(paidBody.status).toBe("paid");

    const afterRes = await pageMemberA.request.get(`${apiUrl}/portal/wallet/balance`, {
      headers: { "x-tenant-slug": slugA, "x-forwarded-for": xff(uniq) },
    });
    const after = (await afterRes.json()) as { balance: string };
    expect(Number(after.balance)).toBeCloseTo(Number(before.balance) + Number(amount), 2);

    // Tenant B never held this payment id at all — no cross-tenant leak of
    // the record, and nothing in tenant B was created or touched by a
    // payload merely claiming its id.
    const crossRes = await pageOwnerB.request.get(`${apiUrl}/rpc/payments/${paymentAId}`, {
      headers: { "x-tenant-slug": slugB, "x-forwarded-for": xff(uniq) },
    });
    expect(crossRes.status()).toBe(404);

    await ctxMemberA.close();
    await ctxOwnerB.close();
  });
});
