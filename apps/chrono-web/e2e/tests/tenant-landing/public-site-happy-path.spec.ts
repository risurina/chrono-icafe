import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * The tenant's own public site, end to end, anonymously — the happy path for
 * `.ai/plans/chrono/in-progress/tenant-white-label-site`.
 *
 * Everything asserted here must be REAL tenant data. The point of that plan is
 * that a public venue page never invents a price, a spec, or a game list, so
 * this spec seeds concrete values and then asserts those exact values render —
 * a fabricated placeholder would fail rather than pass.
 *
 * `/` and `/about` render the same registry-driven sections, so both are
 * checked: the root page's 404 parity with `/about` was itself a bug this plan
 * fixed (see `root-unresolvable-tenant.spec.ts`).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

async function signUp(
  page: import("@playwright/test").Page,
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

async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<string> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();

  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
}

/**
 * Assert the full section set on whichever tenant surface is currently loaded.
 * `/` and `/about` render the same registry output, so the assertions are
 * identical and live in one place.
 */
async function assertTenantSections(
  page: import("@playwright/test").Page,
  {
    tenantName,
    address,
    phone,
    groupName,
    facebook,
    instagram,
  }: {
    tenantName: string;
    address: string;
    phone: string;
    groupName: string;
    facebook: string;
    instagram: string;
  },
) {
  // Hero + live availability, the two sections that already existed.
  await expect(page.getByTestId("landing-section-hero")).toBeVisible();
  await expect(page.getByTestId("landing-section-stations")).toBeVisible();

  // Player CTA — the join / sign-in moment this plan added. Anonymous visitor,
  // so the static branch renders (never the member or apply branch).
  await expect(page.getByTestId("landing-section-playerCta")).toBeVisible();
  const join = page.getByTestId("landing-playercta-join");
  await expect(join).toBeVisible();
  await expect(join).toHaveText(`Join ${tenantName}`);
  await expect(join).toHaveAttribute("href", "/member/sign-up");
  const signIn = page.getByTestId("landing-playercta-signin");
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", "/login");
  // An anonymous visitor must never be bounced to /login by this section.
  await expect(page.getByTestId("landing-playercta-continue")).toHaveCount(0);

  // Experience chips — the tenant's DISTINCT real station types, nothing else.
  await expect(page.getByTestId("landing-section-experience")).toBeVisible();
  await expect(page.getByTestId("landing-experience-pc")).toBeVisible();
  await expect(page.getByTestId("landing-experience-vip")).toBeVisible();
  await expect(page.getByTestId("landing-experience-console")).toHaveCount(0);

  // Real rates from the tenant's own station group — ₱75/hr, members ₱60.
  await expect(page.getByTestId("landing-section-rates")).toBeVisible();
  const rateCard = page.getByTestId(`landing-rate-${groupName}`);
  await expect(rateCard).toBeVisible();
  await expect(rateCard).toContainText("₱75");
  await expect(rateCard).toContainText("Members ₱60 / hr");
  // The deleted DEFAULT_RATES placeholders must never appear again.
  for (const invented of ["Regular rate", "Member rate", "Promo rate"]) {
    await expect(page.getByTestId(`landing-rate-${invented.toLowerCase().replace(/\s+/g, "-")}`)).toHaveCount(0);
  }

  // `specs` / `games` default off — they render hardcoded, non-tenant content.
  await expect(page.getByTestId("landing-section-specs")).toHaveCount(0);
  await expect(page.getByTestId("landing-section-games")).toHaveCount(0);

  // Business info + the tenant's real social profiles.
  const contact = page.getByTestId("landing-section-contact");
  await expect(contact).toBeVisible();
  await expect(contact).toContainText(address);
  await expect(contact).toContainText(phone);
  const fb = page.getByTestId("landing-social-facebook");
  await expect(fb).toBeVisible();
  await expect(fb).toHaveAttribute("href", facebook);
  const ig = page.getByTestId("landing-social-instagram");
  await expect(ig).toBeVisible();
  await expect(ig).toHaveAttribute("href", instagram);
  // A profile the tenant never set must not render a dead link.
  await expect(page.getByTestId("landing-social-tiktok")).toHaveCount(0);

  // Share.
  await expect(page.getByTestId("landing-section-share")).toBeVisible();
  await expect(page.getByTestId("tenant-share-button")).toBeVisible();

  // Footer — both attribution lines.
  await expect(page.getByText("Powered by Chrono")).toBeVisible();
  const partner = page.getByTestId("tenant-footer-partner-link");
  await expect(partner).toBeVisible();
  await expect(partner).toHaveText(/Run your gaming business with Chrono/);
}

test.describe("Tenant white-label site — public happy path", () => {
  test("an anonymous visitor sees real rates, experience, CTAs, contact and share on / and /about", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewhitelabel${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    const branchName = `test-branch-${uniq}`;
    const address = `test-address-${uniq}`;
    const phone = "0917-555-0100";
    const groupName = `test-rate-${uniq}`;
    const facebook = `https://facebook.com/test-${uniq}`;
    const instagram = `https://instagram.com/test-${uniq}`;

    await signUp(page, { name: slug, email, slug });
    const branchId = await createBranch(page, base, branchName);

    const patched = await page.request.patch(`${API_URL}/rpc/branches/${branchId}`, {
      data: {
        address,
        contactNumber: phone,
        email: `venue-${uniq}@example.com`,
        operatingHours: "10:00 - 23:00",
        socialLinks: { facebook, instagram },
      },
    });
    expect(patched.ok()).toBeTruthy();

    // One priced group (renders) plus one zero-rate group (must NOT render —
    // an unpriced group would otherwise publish "₱0 / hr" to the public).
    const priced = await page.request.post(`${API_URL}/rpc/stations/groups`, {
      data: {
        branchId,
        name: groupName,
        code: `RG${uniq.slice(0, 4)}`,
        hourlyRate: 75,
        memberRate: 60,
      },
    });
    expect(priced.ok()).toBeTruthy();

    const unpricedName = `test-unpriced-${uniq}`;
    const unpriced = await page.request.post(`${API_URL}/rpc/stations/groups`, {
      data: {
        branchId,
        name: unpricedName,
        code: `RZ${uniq.slice(0, 4)}`,
        hourlyRate: 0,
      },
    });
    expect(unpriced.ok()).toBeTruthy();

    // Two DISTINCT station types, so the experience chips have something real
    // to be derived from — and a third type is never invented.
    for (const station of [
      { name: "PC-01", stationNumber: "01", stationType: "pc", status: "available" },
      { name: "PC-02", stationNumber: "02", stationType: "pc", status: "available" },
      { name: "VIP-01", stationNumber: "V1", stationType: "vip", status: "maintenance" },
    ]) {
      const created = await page.request.post(`${API_URL}/rpc/stations`, {
        data: { branchId, ...station },
      });
      expect(created.ok()).toBeTruthy();
    }

    // Everything below is the anonymous public site.
    await page.context().clearCookies();

    await page.goto(`${base}/`);
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain(`${base}/`);
    await assertTenantSections(page, {
      tenantName: slug,
      address,
      phone,
      groupName,
      facebook,
      instagram,
    });
    await expect(page.getByText(unpricedName)).toHaveCount(0);

    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");
    await assertTenantSections(page, {
      tenantName: slug,
      address,
      phone,
      groupName,
      facebook,
      instagram,
    });
  });

  test("both / and /about emit tenant-specific OpenGraph metadata", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eogtags${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: slug, email, slug });
    await page.context().clearCookies();

    for (const path of ["/", "/about"]) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");

      await expect(page).toHaveTitle(new RegExp(slug, "i"));
      const ogTitle = page.locator('meta[property="og:title"]');
      await expect(ogTitle).toHaveCount(1);
      await expect(ogTitle).toHaveAttribute("content", new RegExp(slug, "i"));
      // NOTE: `og:description` is deliberately NOT asserted here. It is emitted
      // only when the tenant has set an SEO description or a hero subtitle,
      // and this tenant has configured neither — a fabricated fallback is
      // exactly what this plan removed elsewhere, so its absence here is
      // correct. The next test covers the field once it IS set.
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        "content",
        new RegExp(`${slug}\\.localtest\\.me`),
      );
    }
  });

  test("a saved SEO description reaches og:description on / and /about", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eogdesc${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const description = `Real search & social preview text ${uniq}.`;

    await signUp(page, { name: slug, email, slug });

    // Drive the settings-page editor (the field this plan added), not the API
    // directly, so the UI wiring is covered too.
    await page.goto(`${base}/admin/settings/landing-page`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("SEO description").fill(description);
    await page.getByTestId("landing-save").click();
    await expect(page.getByText("Landing page updated.")).toBeVisible();
    await page.getByTestId("landing-publish").click();
    await expect(page.getByText("Landing page published.")).toBeVisible();

    await page.context().clearCookies();

    for (const path of ["/", "/about"]) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");

      const ogDescription = page.locator('meta[property="og:description"]');
      await expect(ogDescription).toHaveCount(1);
      await expect(ogDescription).toHaveAttribute("content", description);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        description,
      );
    }
  });
});
