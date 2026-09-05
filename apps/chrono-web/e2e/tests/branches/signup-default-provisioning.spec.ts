import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for auto-provisioning a default "Main" branch and
 * Regular/Premium/VIP station groups on a fresh tenant's first dashboard
 * load (chrono/signup-default-provisioning).
 *
 * Asserts via the typed API (`GET /rpc/branches`, `GET /rpc/stations/groups`)
 * rather than a specific dashboard tab's UI, per the plan's own reasoning —
 * this avoids coupling to the in-flight "Station Control" tab-rename work in
 * `stations/page.tsx`. The real sign-up -> real `/admin` navigation still
 * drives the actual feature end-to-end.
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

type BranchDto = { id: string; name: string; code: string };
type StationGroupDto = {
  name: string;
  code: string;
  hourlyRate: string;
  memberRate: string | null;
};

test.describe("Signup default provisioning", () => {
  test("a fresh tenant lands on /admin with a Main branch and Regular/Premium/VIP station groups", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2esdp${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });

    await signUp(page, { name: "PW Owner", email, slug });

    // Give the fire-and-forget provisioning call time to land — poll rather
    // than assert immediately, since it runs concurrently with the rest of
    // the dashboard's own mount-time fetches.
    let branches: BranchDto[] = [];
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${API_URL}/rpc/branches`, {
            params: { pageSize: "10" },
            headers: { "x-tenant-slug": slug },
          });
          if (!res.ok()) return 0;
          branches = (await res.json()).items as BranchDto[];
          return branches.length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // Exactly one branch, named "Main" with the server-derived code "main".
    expect(branches).toHaveLength(1);
    expect(branches[0]?.name).toBe("Main");
    expect(branches[0]?.code).toBe("main");
    const branchId = branches[0]!.id;

    const groupsRes = await page.request.get(`${API_URL}/rpc/stations/groups`, {
      params: { pageSize: "10", branchId },
      headers: { "x-tenant-slug": slug },
    });
    expect(groupsRes.ok()).toBeTruthy();
    const groups = (await groupsRes.json()).items as StationGroupDto[];

    expect(groups).toHaveLength(3);
    const byCode = Object.fromEntries(groups.map((g) => [g.code, g]));

    expect(byCode.regular?.name).toBe("Regular");
    expect(byCode.regular?.hourlyRate).toBe("30.00");
    expect(byCode.regular?.memberRate).toBe("20.00");

    expect(byCode.premium?.name).toBe("Premium");
    expect(byCode.premium?.hourlyRate).toBe("40.00");
    expect(byCode.premium?.memberRate).toBe("30.00");

    expect(byCode.vip?.name).toBe("VIP");
    expect(byCode.vip?.hourlyRate).toBe("50.00");
    expect(byCode.vip?.memberRate).toBe("40.00");
  });
});
