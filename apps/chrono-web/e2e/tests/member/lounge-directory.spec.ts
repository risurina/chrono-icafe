import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Apex "Gaming Lounge Directory" (`/member` home for a signed-in global
 * customer, `agora/customer-auth`) — chrono/portal-lounge-directory-redesign,
 * Phase 4. Covers: happy path (a joined tenant renders "Enter Portal", an
 * unjoined active tenant renders "Apply to Join"), isolation (a suspended
 * tenant never renders as a card), and that clicking "Apply to Join" reaches
 * the target tenant's own `/member` (no dead link / 404) — see
 * `.ai/plans/chrono/in-progress/portal-lounge-directory-redesign/README.md`.
 *
 * `GET /businesses/directory` (the backend this page reads) is a plain,
 * unsearchable listing — page 1, pageSize 10, ordered by `organization.name`
 * ascending (see `businessLeadPublicRoutes()`) — and the shared dev DB this
 * suite runs against already holds hundreds of tenants seeded by other
 * specs. To guarantee our throwaway tenants land on page 1 regardless of how
 * many other tenants exist, their display **name** (not slug — the sign-up
 * form's "Business name" field, independent of the auto-slugified "Business
 * URL") is given a leading digit: ASCII digits sort before every
 * letter-led name already in the dataset (confirmed empirically against the
 * dev DB before writing this spec — the very first item of the full,
 * alphabetically-sorted directory was "Acme Corp", i.e. nothing already
 * sorts earlier than a digit).
 */
const PASSWORD = "Password123!";
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEARCH_PLACEHOLDER = "Search name or slug…";

async function signUpBusiness(
  page: Page,
  { name, slug, email }: { name: string; slug: string; email: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Business name").fill(name);
  // Set the slug explicitly instead of relying on auto-slugify, so the test
  // knows the tenant's host up front.
  await page.getByLabel("Business URL").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

/** Signs the current business owner out via the dashboard shell's icon button. */
async function signOutOwner(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("networkidle");
}

/** Suspends a tenant via the platform admin Organizations surface (same UI
 * flow proven in `platform-admin/organizations.spec.ts` — not a new pattern). */
async function suspendTenant(page: Page, slug: string) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(PLATFORM_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 15_000 });

  await page.goto("/admin/organizations");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill(slug);
  const row = page.getByRole("row").filter({ hasText: slug });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Organization actions" }).click();
  await page.getByRole("menuitem", { name: "Suspend" }).click();
  await page.getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByText(/suspended\./i)).toBeVisible();
}

async function signUpGlobalCustomer(
  page: Page,
  { name, email }: { name: string; email: string },
) {
  await page.goto("/member/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/member$/, { timeout: 30_000 });
}

/** Applies the signed-in global customer to a tenant via its own `/member`
 * (rewritten to the tenant-member tree — see `next.config.ts`), reusing the
 * same `ApplyForTenantPrompt` flow the `global-customers/*` specs exercise. */
async function applyToTenant(page: Page, base: string) {
  await page.goto(`${base}/member`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Join this business" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible({ timeout: 30_000 });
}

test.describe("Gaming Lounge Directory (apex /member)", () => {
  test.describe.configure({ timeout: 420_000 });

  test("joined tenant shows Enter Portal, unjoined shows Apply to Join, suspended never renders, and Apply to Join reaches the tenant's own /member", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric({ length: 8, casing: "lower" });
    const slugJoined = `test-loungejoin${uniq}`;
    const slugUnjoined = `test-loungeskip${uniq}`;
    const slugSuspended = `test-loungesusp${uniq}`;
    // Leading "0 " forces alphabetical-first placement on the directory's
    // single, unsearchable page (see file header) — a plain "test-..." name
    // would sort well past page 1 among the DB's existing tenants.
    const nameJoined = `0 Test Lounge Joined ${uniq}`;
    const nameUnjoined = `0 Test Lounge Unjoined ${uniq}`;
    const nameSuspended = `0 Test Lounge Suspended ${uniq}`;

    // ── Seed three tenants: one the customer will join, one they won't,
    // and one that will be suspended before the customer ever sees it. ──
    await signUpBusiness(page, {
      name: nameJoined,
      slug: slugJoined,
      email: faker.internet.email({ provider: "example.com" }),
    });
    await signOutOwner(page);

    await signUpBusiness(page, {
      name: nameUnjoined,
      slug: slugUnjoined,
      email: faker.internet.email({ provider: "example.com" }),
    });
    await signOutOwner(page);

    await signUpBusiness(page, {
      name: nameSuspended,
      slug: slugSuspended,
      email: faker.internet.email({ provider: "example.com" }),
    });
    await signOutOwner(page);

    await suspendTenant(page, slugSuspended);

    // ── Global customer signs up once, applies to the "joined" tenant only. ──
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await signUpGlobalCustomer(page, { name: "Lounge Directory Customer", email: customerEmail });
    await applyToTenant(page, `http://${slugJoined}.localtest.me:3000`);

    // ── The directory grid on the apex home. ──
    await page.goto("/member");
    await page.waitForLoadState("networkidle");

    const joinedCard = page.getByTestId("lounge-directory-card").filter({ hasText: nameJoined });
    await expect(joinedCard).toBeVisible({ timeout: 20_000 });
    await expect(joinedCard.getByTestId("lounge-directory-card-cta")).toHaveText("Enter Portal");

    const unjoinedCard = page
      .getByTestId("lounge-directory-card")
      .filter({ hasText: nameUnjoined });
    await expect(unjoinedCard).toBeVisible();
    await expect(unjoinedCard.getByTestId("lounge-directory-card-cta")).toHaveText(
      "Apply to Join",
    );

    // ── Isolation: the suspended tenant never renders as a card, anywhere
    // on the page — not filtered out by pagination, filtered out because
    // it's suspended (it shares the same "0 "-prefixed name, so it would
    // have sorted onto page 1 right alongside the other two if it weren't). ──
    await expect(
      page.getByTestId("lounge-directory-card").filter({ hasText: nameSuspended }),
    ).toHaveCount(0);
    await expect(page.getByText(nameSuspended)).toHaveCount(0);

    // ── Clicking "Apply to Join" is a plain same-tab `<a>` (`tenantHref()`,
    // no `target`) to the tenant's own ROOT host — it does not itself append
    // `/member` (confirmed by reading `tenant-links.ts` and by Phase 3's own
    // verification notes: "CTA hrefs resolve to
    // http://<slug>.localtest.me:3002?source=global_directory"). So "reaches
    // the tenant's own /member, no dead link / 404" is checked in two parts:
    // the click lands on a real (non-404) landing page for that tenant, and
    // that tenant's own /member — reachable from that landing page via its
    // "Member login" link — is itself live. ──
    await unjoinedCard.getByTestId("lounge-directory-card-cta").click();
    await page.waitForURL(new RegExp(`^http://${slugUnjoined}\\.localtest\\.me:3000/(\\?.*)?$`), {
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: nameUnjoined }).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.goto(`http://${slugUnjoined}.localtest.me:3000/member`);
    await expect(page.getByRole("heading", { name: "Join this business" })).toBeVisible({
      timeout: 15_000,
    });
  });
});
