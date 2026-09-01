import "dotenv/config";
import "./auth-bootstrap";
import { auth } from "agora/auth";
import { adminDb, withTenant, withAdmin, schema, eq, pool, adminPool } from "agora/db";
import { hashMemberPassword } from "agora/member-auth";
import { createId } from "agora";
import { project, tenantSubscription, tenantSubscriptionEvent } from "./db/schema";

/**
 * Seed two demo tenants. Each gets a staff owner, a customer, and projects.
 *   acme    → staff owner@acme.test    · customer member@acme.test
 *   contoso → staff owner@contoso.test · customer member@contoso.test
 *   (all passwords: Password123!)
 *
 * Staff users are created through Better Auth. Customers are the separate
 * tenant_member pool (RLS-forced, so inserted via withTenant).
 */
const TENANTS = [
  {
    slug: "acme",
    name: "Acme Corp",
    ownerName: "Acme Owner",
    ownerEmail: "owner@acme.test",
    memberName: "Acme Customer",
    memberEmail: "member@acme.test",
    // A third project so acme/contoso have distinguishable project counts —
    // needed for the platform metrics per-tenant table's cross-tenant no-leak
    // e2e assertion (apps/web/e2e/tests/platform-admin/metrics.spec.ts).
    projects: ["First Project", "Second Project", "Third Project"],
  },
  {
    slug: "contoso",
    name: "Contoso Ltd",
    ownerName: "Contoso Owner",
    ownerEmail: "owner@contoso.test",
    memberName: "Contoso Customer",
    memberEmail: "member@contoso.test",
    projects: ["First Project", "Second Project"],
  },
  {
    slug: "globex",
    name: "Globex Inc",
    ownerName: "Globex Owner",
    ownerEmail: "owner@globex.test",
    memberName: "Globex Customer",
    memberEmail: "member@globex.test",
    // Trial-status tenant — gives the admin dashboard's trial-tenant KPI and
    // "tenants past due" section something real to assert on
    // (apps/web/e2e/tests/platform-admin/dashboard.spec.ts).
    projects: ["First Project"],
  },
];

const PASSWORD = "Password123!";

const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_ADMIN_NAME = "Platform Admin";

const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const PLATFORM_VIEWER_NAME = "Platform Viewer";

// tenantSubscription is unique per tenant (tenant_subscription_tenant_uq), so
// each seeded org gets exactly one row here, covering the three statuses the
// admin dashboard's KPIs and e2e spec need real data for.
const SUBSCRIPTIONS: Record<
  string,
  { plan: string; status: string; seats: number }
> = {
  acme: { plan: "pro", status: "active", seats: 10 },
  contoso: { plan: "pro", status: "past_due", seats: 10 },
  globex: { plan: "free", status: "trialing", seats: 3 },
};

async function ensureUser(email: string, name: string): Promise<string> {
  try {
    const res = await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name },
    });
    return res.user.id;
  } catch {
    // Already exists → look it up.
    const [existing] = await adminDb
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (!existing) throw new Error(`Could not create or find user ${email}`);
    return existing.id;
  }
}

async function ensureOrg(slug: string, name: string): Promise<string> {
  const [existing] = await adminDb
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1);
  if (existing) return existing.id;
  const id = createId();
  await adminDb.insert(schema.organization).values({ id, name, slug });
  return id;
}

async function ensureMember(orgId: string, userId: string, role = "owner") {
  const [existing] = await adminDb
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  if (existing) return;
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: orgId,
    userId,
    role,
  });
}

/**
 * A dedicated platform-admin user with no tenant membership — kept separate from
 * every tenant owner so the `platformRole` authorization dimension stays
 * independent of the `member.role` ladder (see `.ai/plans/agora/archive/platform-admin-portal`).
 * Granted the "admin" platform role (every platform permission); "viewer" exists
 * as a read-only role but has no seeded holder.
 */
async function ensurePlatformAdmin() {
  const userId = await ensureUser(PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME);
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, userId));
}

/**
 * A read-only platform-admin holder — previously unseeded (only "admin" had
 * a seeded holder), needed for the dashboard's role-gate e2e case.
 */
async function ensurePlatformViewer() {
  const userId = await ensureUser(PLATFORM_VIEWER_EMAIL, PLATFORM_VIEWER_NAME);
  await adminDb
    .update(schema.user)
    .set({ platformRole: "viewer", role: "impersonator" })
    .where(eq(schema.user.id, userId));
}

/**
 * Idempotently seed one `tenantSubscription` row per tenant (unique per
 * tenant via `tenant_subscription_tenant_uq`) — RLS-forced, tenant-scoped
 * table, so always via `withAdmin()` cross-tenant, never a bare `adminDb`
 * read/write. Gives the platform admin dashboard's trial/past-due KPIs real
 * data locally (`apps/api/src/routes/rpc-admin-metrics.ts`).
 */
async function ensureSubscription(
  orgId: string,
  sub: { plan: string; status: string; seats: number },
) {
  const existing = await withAdmin((tx) =>
    tx
      .select({ id: tenantSubscription.id })
      .from(tenantSubscription)
      .where(eq(tenantSubscription.tenantId, orgId)),
  );
  if (existing.length > 0) return;
  await withAdmin((tx) =>
    tx.insert(tenantSubscription).values({
      id: createId(),
      tenantId: orgId,
      plan: sub.plan,
      status: sub.status,
      seats: sub.seats,
    }),
  );
}

/**
 * Seed one recorded `tenantSubscriptionEvent` row for a tenant, if it doesn't
 * already have one — gives `/admin/reports`'s growth/plan-changes/churn
 * sections something real and distinguishable to assert on
 * (`apps/web/e2e/tests/platform-admin/reports.spec.ts`). RLS-forced,
 * tenant-scoped table, so always via `withTenant` — a bare `adminDb.insert`
 * would silently write zero rows (fail-closed, no `app.tenant_id` set).
 */
async function ensureSubscriptionEvent(
  orgId: string,
  event: {
    previousPlan: string | null;
    newPlan: string;
    previousStatus: string | null;
    newStatus: string;
    source: string;
  },
) {
  await withTenant(orgId, async (tx) => {
    const existing = await tx
      .select({ id: tenantSubscriptionEvent.id })
      .from(tenantSubscriptionEvent)
      .where(eq(tenantSubscriptionEvent.source, event.source));
    if (existing.length > 0) return;
    await tx.insert(tenantSubscriptionEvent).values({
      id: createId(),
      tenantId: orgId,
      previousPlan: event.previousPlan,
      newPlan: event.newPlan,
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
      source: event.source,
    });
  });
}

async function seed() {
  await ensurePlatformAdmin();
  await ensurePlatformViewer();

  const orgIdBySlug: Record<string, string> = {};

  for (const t of TENANTS) {
    const userId = await ensureUser(t.ownerEmail, t.ownerName);
    const orgId = await ensureOrg(t.slug, t.name);
    orgIdBySlug[t.slug] = orgId;
    await ensureMember(orgId, userId);

    // acme also gets a "staff"-ranked (non-owner) member — needed for the
    // billing:manage role-gate e2e case (owner-only), which otherwise has no
    // seeded staff account below owner to test against
    // (apps/web/e2e/tests/billing/paymongo-checkout.spec.ts).
    if (t.slug === "acme") {
      const staffUserId = await ensureUser("staff@acme.test", "Acme Staff");
      await ensureMember(orgId, staffUserId, "staff");
    }

    const sub = SUBSCRIPTIONS[t.slug];
    if (sub) await ensureSubscription(orgId, sub);

    await withTenant(orgId, async (tx) => {
      const existing = await tx.select().from(project);
      if (existing.length === 0) {
        for (const name of t.projects) {
          await tx.insert(project).values({ id: createId(), tenantId: orgId, name });
        }
      }

      // Seed a customer (separate pool) if not present.
      const [existingMember] = await tx
        .select({ id: schema.tenantMember.id })
        .from(schema.tenantMember)
        .where(eq(schema.tenantMember.email, t.memberEmail))
        .limit(1);
      if (!existingMember) {
        await tx.insert(schema.tenantMember).values({
          tenantId: orgId,
          email: t.memberEmail,
          name: t.memberName,
          passwordHash: await hashMemberPassword(PASSWORD),
        });
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      `Seeded ${t.slug} (staff ${t.ownerEmail} · customer ${t.memberEmail} / ${PASSWORD})`,
    );
  }

  // acme: a recorded plan change (free → pro). contoso: a recorded
  // cancellation (pro → canceled) — distinct fixtures so /admin/reports'
  // aggregate-correctness e2e assertion can tell them apart.
  if (orgIdBySlug.acme) {
    await ensureSubscriptionEvent(orgIdBySlug.acme, {
      previousPlan: "free",
      newPlan: "pro",
      previousStatus: "active",
      newStatus: "active",
      source: "webhook",
    });
  }
  if (orgIdBySlug.contoso) {
    await ensureSubscriptionEvent(orgIdBySlug.contoso, {
      previousPlan: "pro",
      newPlan: "pro",
      previousStatus: "active",
      newStatus: "canceled",
      source: "manual_override",
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded platform admin ${PLATFORM_ADMIN_EMAIL} / ${PASSWORD}`);
  // eslint-disable-next-line no-console
  console.log(`Seeded platform viewer ${PLATFORM_VIEWER_EMAIL} / ${PASSWORD}`);
}

seed()
  .then(async () => {
    await pool.end?.();
    if (adminPool !== pool) await adminPool.end?.();
    // eslint-disable-next-line no-console
    console.log("Seed complete.");
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error("Seed failed:", err);
    await (pool.end?.() ?? Promise.resolve()).catch(() => {});
    process.exit(1);
  });
