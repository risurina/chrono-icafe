import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

/** Apply generated SQL migrations (./drizzle) using the admin connection. */
const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_ADMIN or DATABASE_URL");

const pool = new Pool({ connectionString: url });
const db = drizzle(pool);

migrate(db, { migrationsFolder: "./drizzle" })
  .then(async () => {
    // eslint-disable-next-line no-console
    console.log("Migrations applied.");
    await pool.end();
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Migration failed:", err);
    process.exit(1);
  });
