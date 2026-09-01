/**
 * Unit tests for the notification-template resolver/renderer
 * (`.ai/plans/agora/active/notification-template-management`). Standalone tsx
 * script (`pnpm --filter @agora/api test:notification-templates`) — mirrors
 * the inline assertion style of `permissions.test.ts`/`sigv4.test.ts`, the
 * repo has no unit-test runner.
 *
 * Runs against an in-process Postgres (PGlite) with only the
 * `notification_template` table created — no other schema is needed for
 * these two behaviours.
 */
process.env.DB_DRIVER = "pglite";

const { adminDb, pool, schema, eq } = await import("agora/db");
const {
  resolveNotificationTemplate,
  renderNotificationTemplate,
  NOTIFICATION_TEMPLATE_DEFAULTS,
} = await import("agora/server");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

await (pool as unknown as { exec: (sql: string) => Promise<unknown> }).exec(`
  CREATE TABLE "notification_template" (
    "id" text PRIMARY KEY NOT NULL,
    "key" text NOT NULL,
    "subject" text NOT NULL,
    "body_html" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "updated_by" text
  );
  CREATE UNIQUE INDEX "notification_template_key_uq" ON "notification_template" ("key");
`);

console.log("\n── resolveNotificationTemplate never throws (finding 1) ──");
{
  // No override row exists yet → returns the registry default.
  const resolved = await resolveNotificationTemplate("reset-password");
  check(
    "no override row → returns registry default",
    resolved.isOverridden === false &&
      resolved.subject === NOTIFICATION_TEMPLATE_DEFAULTS["reset-password"].subject,
  );

  // Simulate an unreachable/broken adminDb read.
  const originalSelect = adminDb.select.bind(adminDb);
  adminDb.select = (() => {
    throw new Error("simulated adminDb failure");
  }) as typeof adminDb.select;
  let threw = false;
  let fallback: { subject: string; bodyHtml: string; isOverridden: boolean } | null =
    null;
  try {
    fallback = await resolveNotificationTemplate("reset-password");
  } catch {
    threw = true;
  }
  check("resolveNotificationTemplate does not throw when adminDb read fails", !threw);
  check(
    "falls back to registry default on read failure",
    fallback?.isOverridden === false &&
      fallback?.subject === NOTIFICATION_TEMPLATE_DEFAULTS["reset-password"].subject,
  );

  let renderThrew = false;
  let rendered: { subject: string; bodyHtml: string; usedDefault: boolean } | null =
    null;
  try {
    rendered = await renderNotificationTemplate("reset-password", {
      link: "https://example.localtest.me/reset-password?token=abc",
    });
  } catch {
    renderThrew = true;
  }
  check(
    "renderNotificationTemplate still completes end-to-end under DB failure",
    !renderThrew && !!rendered?.bodyHtml.includes("token=abc"),
  );

  adminDb.select = originalSelect;
}

console.log("\n── renderNotificationTemplate falls back on a stale override (finding 2) ──");
{
  // Seed an override for reset-password whose body has had {{link}} stripped.
  await adminDb.insert(schema.notificationTemplate).values({
    key: "reset-password",
    subject: "Reset your password (custom)",
    bodyHtml: "<p>Your password reset link is no longer here. Oops.</p>",
  });

  const resolved = await resolveNotificationTemplate("reset-password");
  check("resolver reports the override as active", resolved.isOverridden === true);

  const rendered = await renderNotificationTemplate("reset-password", {
    link: "https://example.localtest.me/reset-password?token=xyz",
  });
  check(
    "render falls back to the registry default, not the broken override",
    rendered.usedDefault === true &&
      rendered.bodyHtml.includes("token=xyz") &&
      !rendered.bodyHtml.includes("Oops"),
  );

  // Clean up + prove a VALID override is honored (not always falling back).
  await adminDb
    .update(schema.notificationTemplate)
    .set({ bodyHtml: "<p>Click here: {{link}}</p>" })
    .where(eq(schema.notificationTemplate.key, "reset-password"));
  const validOverride = await renderNotificationTemplate("reset-password", {
    link: "https://example.localtest.me/reset-password?token=valid",
  });
  check(
    "a valid override with the required placeholder is honored, not overridden away",
    validOverride.usedDefault === false &&
      validOverride.bodyHtml.includes("token=valid"),
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
