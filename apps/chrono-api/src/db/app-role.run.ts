import "dotenv/config";
import { adminPool, provisionAppRole, roleBypassesRls } from "agora/db";

/**
 * Create/refresh the restricted NOBYPASSRLS role that `DATABASE_URL` should
 * connect as, then verify it cannot bypass RLS.
 *
 * Runs against `DATABASE_URL_ADMIN` (the table owner). The app must NOT connect
 * as the owner: `FORCE ROW LEVEL SECURITY` removes the owner's implicit
 * exemption but cannot override a role's BYPASSRLS attribute, so Neon's default
 * `neondb_owner` silently disables every tenant policy.
 *
 *   APP_DB_ROLE=agora_app APP_DB_PASSWORD='…' pnpm --filter @agora/api db:app-role
 *
 * Then point DATABASE_URL at that role (same host/database, new credentials) and
 * confirm with `pnpm --filter @agora/api rls:proof`.
 */
const role = process.env.APP_DB_ROLE ?? "agora_app";
const password = process.env.APP_DB_PASSWORD;

async function main() {
  if (!password) {
    throw new Error(
      "APP_DB_PASSWORD is required (the password for the restricted app role). " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  await provisionAppRole(adminPool, { role, password });
  if (await roleBypassesRls(adminPool, role)) {
    throw new Error(
      `Role "${role}" still reports BYPASSRLS/superuser — refusing to call this done.`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `App role "${role}" provisioned: NOBYPASSRLS, DML-only on public, not a table owner.\n` +
      `Next: set DATABASE_URL to connect as "${role}", then run rls:proof.`,
  );
  await adminPool.end?.();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to provision the app role:", err.message);
  process.exit(1);
});
