import "dotenv/config";
import pg from "pg";
const { Pool } = pg;

const PW = process.argv[2];
if (!PW) throw new Error("pass password as argv[2]");

// Connect as the OWNER (admin) so we have CREATEROLE + ownership grants.
const admin = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
const p = new Pool({ connectionString: admin });

const stmts = [
  // Restricted app role: can log in, but must NOT bypass RLS and must not own tables.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
       CREATE ROLE app_user LOGIN NOBYPASSRLS;
     END IF;
   END $$;`,
  `ALTER ROLE app_user NOBYPASSRLS;`,
  `ALTER ROLE app_user WITH PASSWORD '${PW}';`,
  `GRANT USAGE ON SCHEMA public TO app_user;`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;`,
  // Future tables created by the owner during migrations become accessible too.
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${'"'}neondb_owner${'"'} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${'"'}neondb_owner${'"'} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;`,
  // Append-only tables: app role may INSERT/SELECT but never UPDATE/DELETE.
  // Guarded so it is a no-op before the table has been migrated in.
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_event') THEN
       REVOKE UPDATE, DELETE ON "audit_event" FROM app_user;
     END IF;
   END $$;`,
];

for (const s of stmts) {
  await p.query(s);
  const head = s.split("\n")[0];
  // Never echo the password to stdout/logs.
  console.log(
    "OK:",
    /PASSWORD/i.test(head)
      ? "ALTER ROLE app_user WITH PASSWORD '***'"
      : head.slice(0, 70),
  );
}

const chk = await p.query("select rolname, rolbypassrls, rolcanlogin from pg_roles where rolname = 'app_user'");
console.log("app_user:", chk.rows[0]);
await p.end();
