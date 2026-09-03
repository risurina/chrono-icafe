import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Browser coverage for the Files page (cloudinary-file-storage plan, Phase 6):
 * pre-signed upload happy path, the staff role gate on delete, and cross-tenant
 * isolation (the private-file leak proof). The exhaustive permission-matrix and
 * RLS proofs live in `pnpm test:e2e` (`apps/api/src/e2e/run.ts`) and
 * `pnpm --filter @agora/api rls:proof`; this spec exercises the real
 * `STORAGE_PROVIDER=local` dev fallback end to end through the actual browser flow.
 */
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";

// A 1x1 transparent PNG — small, valid, and enough to exercise the real upload
// bytes through the local storage adapter.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function uploadFile(
  page: import("@playwright/test").Page,
  { name, isPublic }: { name: string; isPublic: boolean },
) {
  // The Files page's Dropzone uploads immediately on file selection (no
  // separate "Upload" button — see .ai/plans/agora/archive/react-dropzone-upload),
  // so the visibility toggle must be set BEFORE picking the file.
  const publicSwitch = page.getByLabel("Public file");
  if (isPublic) {
    await publicSwitch.click();
  }
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "image/png",
    buffer: PNG_1PX,
  });
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
}

test.describe("Files (pre-signed upload, STORAGE_PROVIDER=local)", () => {
  test("upload a public and a private file; visibility renders correctly", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `e2efiles${uniq}`;
    const email = `pwfiles${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Files", email, slug });
    await page.goto(`${base}/dashboard/files`);
    await page.waitForLoadState("networkidle");

    await uploadFile(page, { name: "public-logo.png", isPublic: true });
    await uploadFile(page, { name: "private-doc.png", isPublic: false });

    // Public row shows visibility badge + a working "Copy URL" action; private
    // row shows "Download" instead, never "Copy URL".
    const publicRow = page.getByRole("row", { name: /public-logo\.png/ });
    await expect(publicRow.getByText("public", { exact: true })).toBeVisible();
    await expect(publicRow.getByRole("button", { name: "Copy URL" })).toBeVisible();

    const privateRow = page.getByRole("row", { name: /private-doc\.png/ });
    await expect(privateRow.getByText("private", { exact: true })).toBeVisible();
    await expect(privateRow.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(privateRow.getByRole("button", { name: "Copy URL" })).toHaveCount(0);
  });

  test("a staff-role member can upload but is blocked from deleting a file", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `e2efilesr${uniq}`;
    const ownerEmail = `pwfilesr${uniq}@example.com`;
    const staffEmail = `ronnie.isurina+${uniq}@gmail.com`;
    const staffSlug = `e2efilesrinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });
    await page.goto(`${base}/dashboard/files`);
    await page.waitForLoadState("networkidle");
    await uploadFile(page, { name: "gate-file.png", isPublic: true });

    // Invite a teammate (default role: staff — file:create/read, no file:delete).
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Staff can upload (file:create) but delete is refused server-side.
    await page.goto(`${base}/dashboard/files`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("gate-file.png")).toBeVisible();
    await uploadFile(page, { name: "staff-uploaded.png", isPublic: true });

    await page.getByRole("button", { name: "Delete gate-file.png" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Only admins can delete files.")).toBeVisible();
    await expect(page.getByText("gate-file.png")).toBeVisible();
  });

  test("a file from one tenant is invisible to another tenant (list + download-url 404)", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slugA = `e2efilesa${uniq}`;
    const slugB = `e2efilesb${uniq}`;
    const emailA = `pwfilesa${uniq}@example.com`;
    const emailB = `pwfilesb${uniq}@example.com`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await page.goto(`http://${slugA}.localtest.me:3000/dashboard/files`);
    await page.waitForLoadState("networkidle");
    await uploadFile(page, { name: "acme-only-file.png", isPublic: true });

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Tenant B", email: emailB, slug: slugB });
    await page.goto(`http://${slugB}.localtest.me:3000/dashboard/files`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search files…").fill("acme-only");
    await expect(page.getByText("No files yet.")).toBeVisible();
    await expect(page.getByText("acme-only-file.png")).toHaveCount(0);
  });
});
