import "dotenv/config";
import {
  adminDb,
  db,
  sql,
  withTenant,
  schema,
  eq,
  pool,
  roleBypassesRls,
} from "agora/db";
import { createId } from "agora";
import { project, tenantSubscriptionEvent, paymentTransaction } from "./db/schema";

/**
 * Proves tenant isolation is real: with app.tenant_id = A, queries must NOT see
 * tenant B's rows, and vice-versa. Run after seeding: `pnpm --filter @agora/api rls:proof`.
 */
async function orgId(slug: string): Promise<string> {
  const [org] = await adminDb
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1);
  if (!org) throw new Error(`Tenant "${slug}" not found — run the seed first.`);
  return org.id;
}

/**
 * The app role MUST be NOBYPASSRLS. `FORCE ROW LEVEL SECURITY` only drops the
 * table owner's implicit exemption — it cannot override a role's BYPASSRLS
 * attribute, so a `DATABASE_URL` pointing at Neon's default `neondb_owner`
 * silently disables every tenant policy while the schema still looks correct.
 * Diagnose it up front so the failure names the cause instead of just leaking.
 */
async function assertAppRoleCannotBypassRls(): Promise<boolean> {
  // `roleBypassesRls` (agora/db) is the single source of truth for this check —
  // it runs against the app connection's `current_user`, the same probe used by
  // `db:app-role`. Only fetch the role name for the diagnostic when it fails.
  if (!(await roleBypassesRls(pool))) return true;
  const res = await db.execute(sql`select current_user::text as role`);
  const role =
    (res as unknown as { rows?: { role: string }[] }).rows?.[0]?.role ??
    "unknown";
  // eslint-disable-next-line no-console
  console.error(
    `RLS PROOF: app role "${role}" has BYPASSRLS — tenant isolation is DISABLED.\n` +
      `DATABASE_URL must point at a restricted NOBYPASSRLS role that does not own the\n` +
      `tables; reserve the owner role for DATABASE_URL_ADMIN. See .ai/rules/database.md.`,
  );
  return false;
}

/**
 * Guarantee the tenant has a project to compare against. The cross-read
 * assertions below key off a row known to belong to the OTHER tenant — with an
 * empty tenant they compare nothing and the proof passes vacuously, which is
 * indistinguishable from isolation actually working. Written through withTenant
 * so the insert itself exercises the WITH CHECK half of the policy.
 */
async function ensureProbeRow(tenantId: string): Promise<string> {
  const existing = await withTenant(tenantId, (tx) =>
    tx.select({ id: project.id }).from(project).limit(1),
  );
  if (existing[0]) return existing[0].id;
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .insert(project)
      .values({ id: createId(), tenantId, name: "rls-proof probe" })
      .returning({ id: project.id }),
  );
  if (!row) throw new Error(`Could not create a probe project for ${tenantId}.`);
  return row.id;
}

/**
 * Same non-vacuity discipline as `ensureProbeRow`, for `tenant_subscription_event`.
 * Written with `source: "rls_probe"` — never deleted (matching the `project`
 * probe's own never-cleaned-up pattern) — so `/rpc-admin/reports` MUST filter
 * `source in ('webhook', 'manual_override', 'override_cleared')` in every
 * query to keep this permanent probe row out of real reported data.
 */
async function ensureSubscriptionEventProbeRow(tenantId: string): Promise<string> {
  const existing = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: tenantSubscriptionEvent.id })
      .from(tenantSubscriptionEvent)
      .where(eq(tenantSubscriptionEvent.source, "rls_probe"))
      .limit(1),
  );
  if (existing[0]) return existing[0].id;
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .insert(tenantSubscriptionEvent)
      .values({
        id: createId(),
        tenantId,
        previousPlan: null,
        newPlan: "free",
        previousStatus: null,
        newStatus: "active",
        source: "rls_probe",
      })
      .returning({ id: tenantSubscriptionEvent.id }),
  );
  if (!row) {
    throw new Error(`Could not create a probe subscription event for ${tenantId}.`);
  }
  return row.id;
}

/**
 * Same non-vacuity discipline as `ensureSubscriptionEventProbeRow`, for the
 * RLS-forced `payment_transaction` mirror. The row carries a sentinel
 * `providerObjectId = 'rls_probe'` so every transactions read route/rollup
 * filters it out (mirroring the `source = 'rls_probe'` exclusion for
 * subscription events) — it is permanent and never cleaned up.
 */
async function ensurePaymentTransactionProbeRow(tenantId: string): Promise<string> {
  // The `payment_transaction_provider_obj_uq` unique index is on
  // (payment_provider, provider_object_id) GLOBALLY — not per tenant — so the
  // sentinel MUST vary per tenant, or the second tenant's insert collides with
  // the first's row (and the RLS-scoped existence check below can't see it to
  // dedupe). All `rls_probe`-prefixed rows are still excluded from every
  // transactions read/rollup via the `NOT LIKE 'rls_probe%'` filters.
  const probeObjectId = `rls_probe_${tenantId}`;
  const existing = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: paymentTransaction.id })
      .from(paymentTransaction)
      .where(eq(paymentTransaction.providerObjectId, probeObjectId))
      .limit(1),
  );
  if (existing[0]) return existing[0].id;
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .insert(paymentTransaction)
      .values({
        id: createId(),
        tenantId,
        paymentProvider: "stripe",
        kind: "charge",
        providerObjectId: probeObjectId,
        amount: "0",
        currency: "usd",
        status: "succeeded",
        occurredAt: new Date(),
      })
      .returning({ id: paymentTransaction.id }),
  );
  if (!row) {
    throw new Error(`Could not create a probe payment transaction for ${tenantId}.`);
  }
  return row.id;
}

async function main() {
  const roleOk = await assertAppRoleCannotBypassRls();
  const a = await orgId("acme");
  const b = await orgId("contoso");

  // Both tenants must hold at least one row, or the cross-reads prove nothing.
  await ensureProbeRow(a);
  await ensureProbeRow(b);
  await ensureSubscriptionEventProbeRow(a);
  await ensureSubscriptionEventProbeRow(b);
  await ensurePaymentTransactionProbeRow(a);
  await ensurePaymentTransactionProbeRow(b);

  const aProjects = await withTenant(a, (tx) => tx.select().from(project));
  const bProjects = await withTenant(b, (tx) => tx.select().from(project));
  const aMembers = await withTenant(a, (tx) =>
    tx.select().from(schema.tenantMember),
  );
  const bMembers = await withTenant(b, (tx) =>
    tx.select().from(schema.tenantMember),
  );
  const aSubEvents = await withTenant(a, (tx) =>
    tx.select().from(tenantSubscriptionEvent),
  );
  const bSubEvents = await withTenant(b, (tx) =>
    tx.select().from(tenantSubscriptionEvent),
  );
  const aTxns = await withTenant(a, (tx) =>
    tx.select().from(paymentTransaction),
  );
  const bTxns = await withTenant(b, (tx) =>
    tx.select().from(paymentTransaction),
  );

  // Under tenant A, none of the returned rows may belong to B.
  const aSeesOnlyA = aProjects.every((p) => p.tenantId === a);
  const bSeesOnlyB = bProjects.every((p) => p.tenantId === b);
  const aMembersOnlyA = aMembers.every((m) => m.tenantId === a);
  const bMembersOnlyB = bMembers.every((m) => m.tenantId === b);
  const aSubEventsOnlyA = aSubEvents.every((e) => e.tenantId === a);
  const bSubEventsOnlyB = bSubEvents.every((e) => e.tenantId === b);
  const aTxnsOnlyA = aTxns.every((t) => t.tenantId === a);
  const bTxnsOnlyB = bTxns.every((t) => t.tenantId === b);

  // Cross-read: ask (as A) for rows we know belong to B → must be empty.
  const bRowId = bProjects[0]?.id;
  const leak = bRowId
    ? await withTenant(a, (tx) =>
        tx.select().from(project).where(eq(project.id, bRowId)),
      )
    : [];
  const bMemberId = bMembers[0]?.id;
  const memberLeak = bMemberId
    ? await withTenant(a, (tx) =>
        tx
          .select()
          .from(schema.tenantMember)
          .where(eq(schema.tenantMember.id, bMemberId)),
      )
    : [];
  const bSubEventId = bSubEvents[0]?.id;
  const subEventLeak = bSubEventId
    ? await withTenant(a, (tx) =>
        tx
          .select()
          .from(tenantSubscriptionEvent)
          .where(eq(tenantSubscriptionEvent.id, bSubEventId)),
      )
    : [];
  const bTxnId = bTxns[0]?.id;
  const txnLeak = bTxnId
    ? await withTenant(a, (tx) =>
        tx
          .select()
          .from(paymentTransaction)
          .where(eq(paymentTransaction.id, bTxnId)),
      )
    : [];

  // Non-vacuity: a comparison against an empty set is not evidence.
  const nonVacuous =
    aProjects.length > 0 &&
    bProjects.length > 0 &&
    Boolean(bRowId) &&
    Boolean(bMemberId) &&
    aSubEvents.length > 0 &&
    bSubEvents.length > 0 &&
    Boolean(bSubEventId) &&
    aTxns.length > 0 &&
    bTxns.length > 0 &&
    Boolean(bTxnId);

  const pass =
    roleOk &&
    nonVacuous &&
    aSeesOnlyA &&
    bSeesOnlyB &&
    aMembersOnlyA &&
    bMembersOnlyB &&
    aSubEventsOnlyA &&
    bSubEventsOnlyB &&
    aTxnsOnlyA &&
    bTxnsOnlyB &&
    leak.length === 0 &&
    memberLeak.length === 0 &&
    subEventLeak.length === 0 &&
    txnLeak.length === 0;

  // eslint-disable-next-line no-console
  console.log(
    [
      `A sees ${aProjects.length} projects (all A's? ${aSeesOnlyA})`,
      `B sees ${bProjects.length} projects (all B's? ${bSeesOnlyB})`,
      `A reading B's project returns ${leak.length} rows (want 0)`,
      `A sees ${aMembers.length} customers (all A's? ${aMembersOnlyA})`,
      `A reading B's customer returns ${memberLeak.length} rows (want 0)`,
      `A sees ${aSubEvents.length} subscription events (all A's? ${aSubEventsOnlyA})`,
      `B sees ${bSubEvents.length} subscription events (all B's? ${bSubEventsOnlyB})`,
      `A reading B's subscription event returns ${subEventLeak.length} rows (want 0)`,
      `A sees ${aTxns.length} payment transactions (all A's? ${aTxnsOnlyA})`,
      `B sees ${bTxns.length} payment transactions (all B's? ${bTxnsOnlyB})`,
      `A reading B's payment transaction returns ${txnLeak.length} rows (want 0)`,
      `non-vacuous (both tenants hold rows)? ${nonVacuous}`,
      pass ? "RLS PROOF: PASS ✅" : "RLS PROOF: FAIL ❌",
    ].join("\n"),
  );
  if (!pass) process.exitCode = 1;
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await (pool.end?.() ?? Promise.resolve()).catch(() => {});
  });
