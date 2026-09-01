import "dotenv/config";
import { adminPool, applyRls, BASE_TENANT_TABLES } from "agora/db";
import { APP_TENANT_TABLES } from "./schema";

/** Enforce RLS on the foundation tables + this app's tenant tables. */
const tables = [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES];

applyRls(adminPool, tables)
  .then(async () => {
    // eslint-disable-next-line no-console
    console.log(`RLS enforced on: ${tables.join(", ")}`);
    await adminPool.end?.();
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to apply RLS:", err);
    process.exit(1);
  });
