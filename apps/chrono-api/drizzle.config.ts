import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Schema DDL runs on the admin (owner) connection and covers the foundation
// tenancy tables + this app's own tables (both re-exported from src/db/schema).
const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_ADMIN or DATABASE_URL");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
