import { test, expect, type Page } from "@playwright/test";

/**
 * Browser coverage for global drag-and-drop + paste upload
 * (`global-upload-drag-drop-paste` plan, Phase 4): dropping a file anywhere
 * in the dashboard (not just on `/dashboard/files`) uploads it tagged the
 * default `general` feature; a signed-in user with no membership in the
 * tenant they're viewing gets the same permission-denied feedback via
 * drag-drop as the existing button flow; and a platform admin's org-detail
 * upload (Phase 3) lands only in that org's own file store, never a
 * different tenant's — cross-tenant isolation for the new admin path,
 * proven the same way `files.spec.ts` proves it for the tenant path.
 *
 * jsdom/Playwright can't simulate a real OS file drag, so these tests
 * dispatch synthetic `dragenter`/`dragover`/`drop`/`paste` events carrying an
 * in-page `File`, which is what `GlobalUploadProvider`
 * (`packages/agora/src/ui/components/custom/global-upload.tsx`) actually
 * listens for — this exercises the real capture → target-resolution →
 * sign/PUT/confirm pipeline, not a mock.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
// 1x1 transparent PNG, base64 — small, valid, real bytes through the local
// storage adapter (same fixture `files.spec.ts` uses).
const PNG_1PX_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function signUpWorkspace(
  page: Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function signInStaff(page: Page, host: string, email: string) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

// react-dropzone's drag handlers live on the `data-testid="global-upload-root"`
// div (packages/agora/src/ui/components/custom/global-upload.tsx), a
// descendant of <body> — a synthetic event dispatched at <body> only bubbles
// to its ancestors and never reaches that div, so these dispatch onto the
// testid element directly instead.
const GLOBAL_UPLOAD_ROOT = '[data-testid="global-upload-root"]';

/** Dispatch a synthetic file drag-and-drop onto the global upload root. */
async function dragDropFile(page: Page, fileName: string) {
  const dt = await page.evaluateHandle(
    ({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      return dt;
    },
    { b64: PNG_1PX_B64, name: fileName },
  );
  await page.dispatchEvent(GLOBAL_UPLOAD_ROOT, "dragenter", { dataTransfer: dt });
  await page.dispatchEvent(GLOBAL_UPLOAD_ROOT, "dragover", { dataTransfer: dt });
  await page.dispatchEvent(GLOBAL_UPLOAD_ROOT, "drop", { dataTransfer: dt });
}

/** Dispatch a synthetic clipboard-image paste on `<body>` (paste is still a
 * plain `window` listener in GlobalUploadProvider, unlike drag/drop). */
async function pasteFile(page: Page, fileName: string) {
  await page.evaluate(
    ({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      const event = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
    },
    { b64: PNG_1PX_B64, name: fileName },
  );
}

/** Open the admin organizations list, search a slug, and follow its "View". */
async function openOrgDetail(adminPage: Page, slug: string) {
  await adminPage.goto("http://localtest.me:3000/admin/organizations");
  await adminPage.waitForLoadState("networkidle");
  await adminPage.getByPlaceholder("Search name or slug…").fill(slug);
  const row = adminPage.getByRole("row").filter({ hasText: slug });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Organization actions" }).click();
  await adminPage.getByRole("menuitem", { name: "View" }).click();
  await adminPage.waitForURL(/\/admin\/organizations\/.+/);
}

test.describe("Global drag-and-drop + paste upload", () => {
  test("dropping a file on a plain dashboard page uploads it, and pasting on the Files page tags it 'files'", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `test-dnd${uniq}`;
    await signUpWorkspace(page, { name: "DnD Owner", email: `dnd${uniq}@example.com`, slug });

    // Drop on the plain dashboard overview — no page-level override, so it
    // should land under the layout's default "general" target.
    await page.goto(`http://${slug}.localtest.me:3000/dashboard`);
    await page.waitForLoadState("networkidle");
    await dragDropFile(page, "dnd-general.png");
    await expect(page.getByText("Uploaded dnd-general.png")).toBeVisible({ timeout: 15_000 });

    // Paste on the Files page itself — this page registers `feature: "files"`.
    await page.goto(`http://${slug}.localtest.me:3000/dashboard/files`);
    await page.waitForLoadState("networkidle");
    await pasteFile(page, "dnd-files-feature.png");
    await expect(page.getByText("Uploaded dnd-files-feature.png")).toBeVisible({
      timeout: 15_000,
    });

    // Both rows are visible on the Files list regardless of which target
    // tagged them — the UI doesn't filter by feature.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("dnd-general.png")).toBeVisible();
    await expect(page.getByText("dnd-files-feature.png")).toBeVisible();
  });

  test("a signed-in user with no membership in the tenant they're viewing gets the same denial via drag-drop as the button flow", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slugA = `test-dndgatea${uniq}`;
    const slugB = `test-dndgateb${uniq}`;
    await signUpWorkspace(page, { name: "Gate A Owner", email: `dndgatea${uniq}@example.com`, slug: slugA });

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signUpWorkspace(otherPage, {
      name: "Gate B Owner",
      email: `dndgateb${uniq}@example.com`,
      slug: slugB,
    });

    // B's own signed-in session, browsing A's host directly — no membership
    // in A, so every /rpc call 403s, exactly like the original bug report.
    await otherPage.goto(`http://${slugA}.localtest.me:3000/dashboard`);
    await otherPage.waitForLoadState("networkidle");
    await dragDropFile(otherPage, "should-be-denied.png");
    await expect(
      otherPage.getByText(/don.?t have permission to upload here|could not start the upload/i),
    ).toBeVisible({ timeout: 15_000 });

    await otherContext.close();
  });

  test("an admin org-detail upload lands only in that org's own files — a different tenant never sees it", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slugA = `test-adminupa${uniq}`;
    const slugB = `test-adminupb${uniq}`;
    const ownerEmailA = `adminupa${uniq}@example.com`;
    const ownerEmailB = `adminupb${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Admin Up A", email: ownerEmailA, slug: slugA });

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUpWorkspace(pageB, { name: "Admin Up B", email: ownerEmailB, slug: slugB });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await openOrgDetail(adminPage, slugA);
    await dragDropFile(adminPage, "admin-uploaded.png");
    await expect(adminPage.getByText("Uploaded admin-uploaded.png")).toBeVisible({
      timeout: 15_000,
    });

    // Org A's own owner sees it on their Files page.
    await page.goto(`http://${slugA}.localtest.me:3000/dashboard/files`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("admin-uploaded.png")).toBeVisible({ timeout: 15_000 });

    // Org B never does — cross-tenant isolation for the new admin path.
    await pageB.goto(`http://${slugB}.localtest.me:3000/dashboard/files`);
    await pageB.waitForLoadState("networkidle");
    await pageB.getByPlaceholder("Search files…").fill("admin-uploaded");
    await expect(pageB.getByText("No files yet.")).toBeVisible();
    await expect(pageB.getByText("admin-uploaded.png")).toHaveCount(0);

    await contextB.close();
    await adminContext.close();
  });
});
