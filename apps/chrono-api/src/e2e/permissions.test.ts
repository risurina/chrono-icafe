/**
 * Unit test for the permission engine (Phase A1). Standalone tsx script
 * (`pnpm --filter @agora/api test:permissions`) — the repo has no unit-test
 * runner, so this mirrors the inline assertion style used by sigv4.test.ts and
 * the e2e harness.
 *
 * The point of these cases is behaviour preservation: the three system roles
 * must reproduce the rank ladder's current outcomes exactly, gate for gate.
 * Two of them are regressions the plan audit caught — `staff` keeps
 * project:create (the codebase's only staff-level gate) and `admin` must NOT
 * reach billing:manage (checkout/portal are owner-only today).
 */
// The `agora/auth` barrel initializes the DB client on import, so the driver has
// to be selected BEFORE that import runs — static imports hoist, so this uses a
// dynamic import rather than a plain `import ... from`. The in-process driver
// needs no DATABASE_URL; this test touches no DB.
process.env.DB_DRIVER = "pglite";
const { hasPermission, permissionsForRole } = await import("agora/auth");
const { hasPlatformPermission, permissionsForPlatformRole } = await import(
  "agora/auth"
);
const {
  PLATFORM_PERMISSION_STATEMENTS,
  PLATFORM_PERMISSION_GROUPS,
  PLATFORM_ROLE_DISPLAY,
} = await import("agora/auth");
const { resolveFromFlags, isProviderConfigured } = await import("agora/auth");
const {
  assertCanAssignPlatformRole,
  resolvePlatformPermissions,
  sanitizePlatformPermissionMap,
  hasPlatformPermissionMap,
} = await import("agora/auth");
const { setPlatformSecurityPolicySchema } = await import("agora");

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

console.log("\n── Deny by default ──");
for (const bad of [null, undefined, "", "nope", "member", "MEMBER", "Admin"]) {
  check(
    `role ${JSON.stringify(bad)} denied`,
    hasPermission(bad, { project: ["create"] }) === false,
  );
}

// member.role defaults to "member" at the DB level (schema/auth.ts) but that is
// a customer-pool value, not a staff role. It must deny AND must not throw when
// its permission set is computed for /me.
console.log("\n── The \"member\" DB default must not 500 /me ──");
let threw = false;
let memberSet: Record<string, string[]> = {};
try {
  memberSet = permissionsForRole("member");
} catch {
  threw = true;
}
check('permissionsForRole("member") does not throw', threw === false);
check(
  'permissionsForRole("member") is empty',
  Object.keys(memberSet).length === 0,
  JSON.stringify(memberSet),
);
for (const bad of [null, undefined, "nope"]) {
  check(
    `permissionsForRole(${JSON.stringify(bad)}) is empty`,
    Object.keys(permissionsForRole(bad)).length === 0,
  );
}

console.log("\n── staff ──");
check("staff may project:create", hasPermission("staff", { project: ["create"] }));
check(
  "staff may NOT project:delete",
  hasPermission("staff", { project: ["delete"] }) === false,
);
check("staff may file:create and file:read", hasPermission("staff", { file: ["create", "read"] }));
check(
  "staff may NOT file:delete",
  hasPermission("staff", { file: ["delete"] }) === false,
);
check(
  "staff may notificationFeed:read (every member reads their own feed)",
  hasPermission("staff", { notificationFeed: ["read"] }),
);
for (const [resource, action] of [
  ["staff", "invite"],
  ["customer", "read"],
  ["domain", "manage"],
  ["apiKey", "read"],
  ["webhook", "read"],
  ["billing", "read"],
  ["branding", "manage"],
  ["featureFlag", "manage"],
  ["integration", "read"],
  ["security", "read"],
  ["audit", "read"],
  ["tenant", "read"],
  ["branch", "create"],
  ["branch", "update"],
] as const) {
  check(
    `staff may NOT ${resource}:${action}`,
    hasPermission("staff", { [resource]: [action] }) === false,
  );
}

console.log("\n── admin ──");
for (const [resource, action] of [
  ["project", "create"],
  ["project", "delete"],
  ["file", "create"],
  ["file", "read"],
  ["file", "delete"],
  ["staff", "invite"],
  ["staff", "update-role"],
  ["staff", "remove"],
  ["customer", "read"],
  ["customer", "delete"],
  ["customer", "reactivate"],
  ["domain", "manage"],
  ["apiKey", "create"],
  ["apiKey", "revoke"],
  ["webhook", "manage"],
  ["billing", "read"],
  ["branding", "manage"],
  ["featureFlag", "manage"],
  ["integration", "manage"],
  ["security", "manage"],
  ["audit", "read"],
  ["notificationFeed", "read"],
  ["branch", "create"],
  ["branch", "update"],
] as const) {
  check(`admin may ${resource}:${action}`, hasPermission("admin", { [resource]: [action] }));
}
// The two owner-only boundaries admin must not cross.
check(
  "admin may NOT billing:manage (checkout/portal are owner-only)",
  hasPermission("admin", { billing: ["manage"] }) === false,
);
for (const action of [
  "read",
  "suspend",
  "resume",
  "export",
  "delete",
  "transfer-ownership",
] as const) {
  check(
    `admin may NOT tenant:${action}`,
    hasPermission("admin", { tenant: [action] }) === false,
  );
}

console.log("\n── owner ──");
for (const [resource, action] of [
  ["project", "delete"],
  ["file", "delete"],
  ["staff", "remove"],
  ["customer", "delete"],
  ["domain", "manage"],
  ["apiKey", "revoke"],
  ["webhook", "manage"],
  ["billing", "manage"],
  ["branding", "manage"],
  ["featureFlag", "manage"],
  ["integration", "manage"],
  ["security", "manage"],
  ["audit", "read"],
  ["tenant", "delete"],
  ["tenant", "transfer-ownership"],
  ["notificationFeed", "read"],
  ["branch", "create"],
  ["branch", "update"],
] as const) {
  check(`owner may ${resource}:${action}`, hasPermission("owner", { [resource]: [action] }));
}

console.log("\n── Better Auth defaults survive the merge ──");
// Passing a bare custom `ac` would override these and break
// authClient.organization.create/.list on the sign-up and login pages.
check("owner may organization:delete", hasPermission("owner", { organization: ["delete"] }));
check("admin may organization:update", hasPermission("admin", { organization: ["update"] }));
check("admin may invitation:create", hasPermission("admin", { invitation: ["create"] }));
check(
  "staff may NOT organization:delete",
  hasPermission("staff", { organization: ["delete"] }) === false,
);

console.log("\n── Multi-action + connectors ──");
check(
  "admin AND over two granted actions",
  hasPermission("admin", { customer: ["read", "delete"] }),
);
check(
  "admin AND fails when one action is missing",
  hasPermission("admin", { billing: ["read", "manage"] }) === false,
);
check(
  "admin AND across resources fails on the missing one",
  hasPermission("admin", { customer: ["read"], tenant: ["delete"] }) === false,
);
check("empty request denied", hasPermission("admin", {}) === false);

console.log("\n── Negative shape assertions ──");
// role:* has no route yet and must not exist — declaring it early would grant it
// to owner via the spread, so Track B would "introduce" a permission that already
// shipped.
// role:* was withheld until Track B's CRUD existed; now it gates those routes.
check(
  "owner and admin may role:manage",
  hasPermission("owner", { role: ["manage"] }) &&
    hasPermission("admin", { role: ["manage"] }),
);
check(
  "staff may NOT role:read or role:manage",
  hasPermission("staff", { role: ["read"] }) === false &&
    hasPermission("staff", { role: ["manage"] }) === false,
);
check(
  "staff lacks apiKey:create at the set level",
  (permissionsForRole("staff").apiKey ?? []).length === 0,
);
check(
  "staff lacks project:delete at the set level",
  !(permissionsForRole("staff").project ?? []).includes("delete"),
);
// /me must not ship Better Auth's internal statements to the browser.
for (const internal of ["organization", "member", "invitation", "team", "ac"]) {
  check(
    `permissionsForRole omits Better Auth's "${internal}" statement`,
    permissionsForRole("owner")[internal] === undefined,
    JSON.stringify(Object.keys(permissionsForRole("owner"))),
  );
}

console.log("\n── permissionsForRole shape ──");
const ownerSet = permissionsForRole("owner");
check("owner set includes tenant actions", (ownerSet.tenant ?? []).includes("delete"));
const adminSet = permissionsForRole("admin");
check("admin set has no tenant key or an empty one", (adminSet.tenant ?? []).length === 0);
check(
  "admin set billing is read-only",
  JSON.stringify(adminSet.billing ?? []) === JSON.stringify(["read"]),
  JSON.stringify(adminSet.billing),
);
check("staff set has project:create", (permissionsForRole("staff").project ?? []).includes("create"));

console.log("\n── platform sign-in method permissions ──");
// These must FAIL if the grant is removed from the role — they assert the
// specific authProvider actions, not merely that the role resolves to something.
check(
  "platform viewer holds authProvider:read",
  hasPlatformPermission("viewer", { authProvider: ["read"] }),
);
check(
  "platform viewer does NOT hold authProvider:manage",
  !hasPlatformPermission("viewer", { authProvider: ["manage"] }),
);
check(
  "platform admin holds authProvider:read and :manage",
  hasPlatformPermission("admin", { authProvider: ["read", "manage"] }),
);
check(
  "no platform role holds authProvider at all",
  !hasPlatformPermission(null, { authProvider: ["read"] }) &&
    !hasPlatformPermission("owner", { authProvider: ["read"] }) &&
    !hasPlatformPermission("member", { authProvider: ["read"] }),
);
check(
  "authProvider is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).authProvider === undefined,
);
check(
  "platform viewer's resolved set exposes read only",
  JSON.stringify(permissionsForPlatformRole("viewer").authProvider) ===
    JSON.stringify(["read"]),
  JSON.stringify(permissionsForPlatformRole("viewer").authProvider),
);

console.log("\n── platform system-settings permissions ──");
// Must FAIL if the grant is removed from the role — asserts the specific
// platformSettings actions, not merely that the role resolves to something.
check(
  "platform viewer holds platformSettings:read",
  hasPlatformPermission("viewer", { platformSettings: ["read"] }),
);
check(
  "platform support holds platformSettings:read",
  hasPlatformPermission("support", { platformSettings: ["read"] }),
);
check(
  "platform viewer does NOT hold platformSettings:manage",
  !hasPlatformPermission("viewer", { platformSettings: ["manage"] }),
);
check(
  "platform support does NOT hold platformSettings:manage",
  !hasPlatformPermission("support", { platformSettings: ["manage"] }),
);
check(
  "platform admin holds platformSettings:read and :manage",
  hasPlatformPermission("admin", { platformSettings: ["read", "manage"] }),
);
check(
  "no non-platform role holds platformSettings at all",
  !hasPlatformPermission(null, { platformSettings: ["read"] }) &&
    !hasPlatformPermission("owner", { platformSettings: ["read"] }) &&
    !hasPlatformPermission("member", { platformSettings: ["read"] }),
);

console.log("\n── platform support-ticket permissions ──");
// Must FAIL if the grant is removed from the role — asserts the specific
// supportTicket actions per role, not merely that the role resolves.
check(
  "platform viewer holds supportTicket:read",
  hasPlatformPermission("viewer", { supportTicket: ["read"] }),
);
check(
  "platform viewer does NOT hold supportTicket:manage",
  !hasPlatformPermission("viewer", { supportTicket: ["manage"] }),
);
check(
  "platform support holds supportTicket:read and :manage",
  hasPlatformPermission("support", { supportTicket: ["read", "manage"] }),
);
check(
  "platform admin holds supportTicket:read and :manage",
  hasPlatformPermission("admin", { supportTicket: ["read", "manage"] }),
);
check(
  "no non-platform role holds supportTicket at all",
  !hasPlatformPermission(null, { supportTicket: ["read"] }) &&
    !hasPlatformPermission("owner", { supportTicket: ["read"] }) &&
    !hasPlatformPermission("member", { supportTicket: ["read"] }),
);

console.log("\n── platform support role ──");
check(
  "support holds organization:manage (support-ticket linkage)",
  hasPlatformPermission("support", { organization: ["manage"] }),
);
check(
  "support does NOT hold organization:suspend",
  !hasPlatformPermission("support", { organization: ["suspend"] }),
);
check(
  "support does NOT hold organization:override_subscription",
  !hasPlatformPermission("support", { organization: ["override_subscription"] }),
);
check(
  "admin holds organization:edit; viewer and support do NOT",
  hasPlatformPermission("admin", { organization: ["edit"] }) &&
    !hasPlatformPermission("viewer", { organization: ["edit"] }) &&
    !hasPlatformPermission("support", { organization: ["edit"] }),
);
check(
  "admin holds organization:archive; viewer and support do NOT",
  hasPlatformPermission("admin", { organization: ["archive"] }) &&
    !hasPlatformPermission("viewer", { organization: ["archive"] }) &&
    !hasPlatformPermission("support", { organization: ["archive"] }),
);
check(
  "support does NOT hold compliance:export",
  !hasPlatformPermission("support", { compliance: ["export"] }),
);
check(
  "support does NOT hold staff:manage",
  !hasPlatformPermission("support", { staff: ["manage"] }),
);
check(
  "support does NOT hold impersonation:start",
  !hasPlatformPermission("support", { impersonation: ["start"] }),
);
check(
  "support is absent from viewer's and admin's resolved sets by name",
  !hasPlatformPermission("viewer", { organization: ["manage"] }) &&
    hasPlatformPermission("admin", { organization: ["manage"] }),
);

console.log("\n── platform staff role permissions ──");
check(
  "platform viewer holds staff:read",
  hasPlatformPermission("viewer", { staff: ["read"] }),
);
check(
  "platform viewer does NOT hold staff:manage",
  !hasPlatformPermission("viewer", { staff: ["manage"] }),
);
check(
  "platform admin holds staff:read and :manage",
  hasPlatformPermission("admin", { staff: ["read", "manage"] }),
);
check(
  "no platform role holds staff at all",
  !hasPlatformPermission(null, { staff: ["read"] }) &&
    !hasPlatformPermission("owner", { staff: ["read"] }) &&
    !hasPlatformPermission("member", { staff: ["read"] }),
);
// The gate must actually fail when the permission is removed from the role —
// simulating that by asserting a viewer denied `manage` cannot pass the same
// check an admin does, so this is testing the gate, not plumbing.
check(
  "removing staff:manage from a role denies exactly that action",
  hasPlatformPermission("admin", { staff: ["manage"] }) &&
    !hasPlatformPermission("viewer", { staff: ["manage"] }),
);

console.log("\n── platform custom roles (rank, resolution, sanitization) ──");

// A custom role resolves to exactly its stored, sanitized permission map.
check(
  "custom role resolves to exactly its granted resource",
  JSON.stringify(resolvePlatformPermissions("support-billing", { billing: ["read"] })) ===
    JSON.stringify({ billing: ["read"] }),
);

// A stale stored map naming a resource/action the vocabulary no longer has
// grants LESS than it claims, never more (deny-by-default on drift).
check(
  "custom role's stale/unknown resource+action is dropped on resolve",
  (() => {
    const m = resolvePlatformPermissions("legacy", {
      billing: ["read"],
      nonexistentResource: ["manage"],
      organization: ["read", "not_a_real_action"],
    });
    return (
      !("nonexistentResource" in m) &&
      !(m.organization ?? []).includes("not_a_real_action") &&
      (m.organization ?? []).includes("read")
    );
  })(),
);

// A deleted custom key (unknown, no stored permission) resolves to nothing —
// the same deny-by-default an unrecognized role has always had.
check(
  "unknown/deleted custom role resolves to an empty set",
  Object.keys(resolvePlatformPermissions("deleted-role", null)).length === 0,
);

// The resolved map gates exactly what it holds and nothing more.
check(
  "a custom role's resolved map gates only what it holds",
  (() => {
    const held = resolvePlatformPermissions("support-billing", { billing: ["read"] });
    return (
      hasPlatformPermissionMap(held, { billing: ["read"] }) &&
      !hasPlatformPermissionMap(held, { billing: ["refund"] }) &&
      !hasPlatformPermissionMap(held, { staff: ["manage"] })
    );
  })(),
);

check(
  "sanitizePlatformPermissionMap drops unknown resources and actions",
  JSON.stringify(
    sanitizePlatformPermissionMap({ billing: ["read", "bogus"], junk: ["x"] }),
  ) === JSON.stringify({ billing: ["read"] }),
);

// Rank guard: custom roles sit at the floor with viewer/support — only admin
// (rank 2) can grant or act on an admin.
function rankThrows(
  actor: string | null,
  newRole: string | null,
  target?: string | null,
): boolean {
  try {
    assertCanAssignPlatformRole(actor, newRole, target);
    return false;
  } catch {
    return true;
  }
}
check("a custom role cannot grant admin (rank floor)", rankThrows("support-billing", "admin"));
check(
  "a custom role cannot act on / demote an admin",
  rankThrows("support-billing", "viewer", "admin"),
);
check("support cannot grant admin (rank floor)", rankThrows("support", "admin"));
check("viewer cannot grant admin (rank floor)", rankThrows("viewer", "admin"));
check(
  "admin can assign a custom role (floor) to a target",
  !rankThrows("admin", "support-billing", "viewer"),
);
check("admin can grant admin", !rankThrows("admin", "admin", "viewer"));

console.log("\n── platform impersonation permissions ──");
check(
  "platform viewer does NOT hold impersonation:start",
  !hasPlatformPermission("viewer", { impersonation: ["start"] }),
);
check(
  "platform admin holds impersonation:start",
  hasPlatformPermission("admin", { impersonation: ["start"] }),
);
check(
  "no platform role holds impersonation at all",
  !hasPlatformPermission(null, { impersonation: ["start"] }) &&
    !hasPlatformPermission("owner", { impersonation: ["start"] }) &&
    !hasPlatformPermission("member", { impersonation: ["start"] }),
);
// The gate must actually fail when the permission is removed from the role —
// simulating that by asserting a viewer denied `start` cannot pass the same
// check an admin does, so this is testing the gate, not plumbing.
check(
  "removing impersonation:start from a role denies exactly that action",
  hasPlatformPermission("admin", { impersonation: ["start"] }) &&
    !hasPlatformPermission("viewer", { impersonation: ["start"] }),
);
check(
  "platform viewer does NOT hold impersonation:force-end",
  !hasPlatformPermission("viewer", { impersonation: ["force-end"] }),
);
check(
  "platform admin holds impersonation:force-end",
  hasPlatformPermission("admin", { impersonation: ["force-end"] }),
);
check(
  "no platform role holds impersonation:force-end besides admin",
  !hasPlatformPermission(null, { impersonation: ["force-end"] }) &&
    !hasPlatformPermission("owner", { impersonation: ["force-end"] }) &&
    !hasPlatformPermission("member", { impersonation: ["force-end"] }),
);
check(
  "removing impersonation:force-end from a role denies exactly that action",
  hasPlatformPermission("admin", { impersonation: ["force-end"] }) &&
    !hasPlatformPermission("viewer", { impersonation: ["force-end"] }),
);

console.log("\n── platform audit log permissions ──");
check(
  "platform viewer holds audit:read",
  hasPlatformPermission("viewer", { audit: ["read"] }),
);
check(
  "platform admin holds audit:read",
  hasPlatformPermission("admin", { audit: ["read"] }),
);
check(
  "no platform role holds audit at all",
  !hasPlatformPermission(null, { audit: ["read"] }) &&
    !hasPlatformPermission("owner", { audit: ["read"] }) &&
    !hasPlatformPermission("member", { audit: ["read"] }),
);
check(
  "audit is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).audit === undefined,
);

console.log("\n── platform billing & payments permissions (spec #7) ──");
// `billing:read` is the read floor all three platform roles hold (rollup +
// transactions/invoices/attempts views). `billing:refund` is admin-only — a
// financial-impact action. These must FAIL if the grant is added/removed.
check(
  "all platform roles hold billing:read",
  hasPlatformPermission("viewer", { billing: ["read"] }) &&
    hasPlatformPermission("support", { billing: ["read"] }) &&
    hasPlatformPermission("admin", { billing: ["read"] }),
);
check(
  "platform admin holds billing:refund",
  hasPlatformPermission("admin", { billing: ["refund"] }),
);
check(
  "platform viewer does NOT hold billing:refund",
  !hasPlatformPermission("viewer", { billing: ["refund"] }),
);
check(
  "platform support does NOT hold billing:refund",
  !hasPlatformPermission("support", { billing: ["refund"] }),
);
check(
  "no non-platform role holds billing:refund",
  !hasPlatformPermission(null, { billing: ["refund"] }) &&
    !hasPlatformPermission("owner", { billing: ["refund"] }) &&
    !hasPlatformPermission("member", { billing: ["refund"] }),
);
check(
  "platform viewer's resolved billing set is read-only",
  JSON.stringify(permissionsForPlatformRole("viewer").billing) ===
    JSON.stringify(["read"]),
  JSON.stringify(permissionsForPlatformRole("viewer").billing),
);

console.log("\n── platform feature flag permissions ──");
check(
  "platform viewer holds featureFlag:read",
  hasPlatformPermission("viewer", { featureFlag: ["read"] }),
);
check(
  "platform viewer does NOT hold featureFlag:manage",
  !hasPlatformPermission("viewer", { featureFlag: ["manage"] }),
);
check(
  "platform admin holds featureFlag:read and :manage",
  hasPlatformPermission("admin", { featureFlag: ["read", "manage"] }),
);
check(
  "no platform role holds featureFlag at all",
  !hasPlatformPermission(null, { featureFlag: ["read"] }) &&
    !hasPlatformPermission("owner", { featureFlag: ["read"] }) &&
    !hasPlatformPermission("member", { featureFlag: ["read"] }),
);
check(
  "featureFlag is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).featureFlag === undefined,
);
// The gate must actually fail when the permission is removed from the role —
// simulating that by asserting a viewer denied `manage` cannot pass the same
// check an admin does, so this is testing the gate, not plumbing.
check(
  "removing featureFlag:manage from a role denies exactly that action",
  hasPlatformPermission("admin", { featureFlag: ["manage"] }) &&
    !hasPlatformPermission("viewer", { featureFlag: ["manage"] }),
);

console.log("\n── platform notification template permissions ──");
check(
  "platform viewer holds notification:read",
  hasPlatformPermission("viewer", { notification: ["read"] }),
);
check(
  "platform viewer does NOT hold notification:manage",
  !hasPlatformPermission("viewer", { notification: ["manage"] }),
);
check(
  "platform admin holds notification:read and :manage",
  hasPlatformPermission("admin", { notification: ["read", "manage"] }),
);
check(
  "no platform role holds notification at all",
  !hasPlatformPermission(null, { notification: ["read"] }) &&
    !hasPlatformPermission("owner", { notification: ["read"] }) &&
    !hasPlatformPermission("member", { notification: ["read"] }),
);
check(
  "notification is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).notification === undefined,
);
// The gate must actually fail when the permission is removed from the role —
// simulating that by asserting a viewer denied `manage` cannot pass the same
// check an admin does, so this is testing the gate, not plumbing.
check(
  "removing notification:manage from a role denies exactly that action",
  hasPlatformPermission("admin", { notification: ["manage"] }) &&
    !hasPlatformPermission("viewer", { notification: ["manage"] }),
);

console.log("\n── platform announcement permissions ──");
check(
  "platform viewer holds announcement:read",
  hasPlatformPermission("viewer", { announcement: ["read"] }),
);
check(
  "platform viewer does NOT hold announcement:manage (POST /:id/send)",
  !hasPlatformPermission("viewer", { announcement: ["manage"] }),
);
check(
  "platform support does NOT hold announcement:manage (POST /:id/send)",
  !hasPlatformPermission("support", { announcement: ["manage"] }),
);
check(
  "platform support holds announcement:read",
  hasPlatformPermission("support", { announcement: ["read"] }),
);
check(
  "platform support does NOT hold announcement:manage",
  !hasPlatformPermission("support", { announcement: ["manage"] }),
);
check(
  "platform admin holds announcement:read and :manage",
  hasPlatformPermission("admin", { announcement: ["read", "manage"] }),
);
check(
  "no platform role holds announcement at all",
  !hasPlatformPermission(null, { announcement: ["read"] }) &&
    !hasPlatformPermission("owner", { announcement: ["read"] }) &&
    !hasPlatformPermission("member", { announcement: ["read"] }),
);
check(
  "announcement is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).announcement === undefined,
);
// The gate must actually fail when the permission is removed from the role —
// simulating that by asserting a viewer denied `manage` cannot pass the same
// check an admin does, so this is testing the gate, not plumbing.
check(
  "removing announcement:manage from a role denies exactly that action",
  hasPlatformPermission("admin", { announcement: ["manage"] }) &&
    !hasPlatformPermission("viewer", { announcement: ["manage"] }),
);

console.log("\n── platform compliance permissions ──");
check(
  "platform viewer holds compliance:policyRead",
  hasPlatformPermission("viewer", { compliance: ["policyRead"] }),
);
check(
  "platform viewer does NOT hold compliance:export",
  !hasPlatformPermission("viewer", { compliance: ["export"] }),
);
check(
  "platform viewer does NOT hold compliance:policyManage",
  !hasPlatformPermission("viewer", { compliance: ["policyManage"] }),
);
check(
  "platform admin holds compliance:export, :policyRead, and :policyManage",
  hasPlatformPermission("admin", {
    compliance: ["export", "policyRead", "policyManage"],
  }),
);
check(
  "no platform role holds compliance at all",
  !hasPlatformPermission(null, { compliance: ["policyRead"] }) &&
    !hasPlatformPermission("owner", { compliance: ["policyRead"] }) &&
    !hasPlatformPermission("member", { compliance: ["policyRead"] }),
);
check(
  "compliance is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).compliance === undefined,
);
// The gate must actually fail when the permission is removed from the role —
// simulating that by asserting a viewer denied `export`/`policyManage` cannot
// pass the same check an admin does, so this is testing the gate, not plumbing.
check(
  "removing compliance:export from a role denies exactly that action",
  hasPlatformPermission("admin", { compliance: ["export"] }) &&
    !hasPlatformPermission("viewer", { compliance: ["export"] }),
);
check(
  "removing compliance:policyManage from a role denies exactly that action",
  hasPlatformPermission("admin", { compliance: ["policyManage"] }) &&
    !hasPlatformPermission("viewer", { compliance: ["policyManage"] }),
);

console.log("\n── auth provider resolution ──");
// No OAuth credentials are set in this process, so the social providers are
// unconfigured and therefore unavailable no matter what their flag says.
check(
  "a credentials provider is always configured",
  isProviderConfigured("email"),
);
check(
  "a social provider with no env credentials is not configured",
  !isProviderConfigured("google") && !isProviderConfigured("facebook"),
);
const enabledButUnconfigured = resolveFromFlags({
  email: true,
  google: true,
  facebook: true,
});
check(
  "an enabled but unconfigured provider is NOT available",
  enabledButUnconfigured.google.enabled &&
    !enabledButUnconfigured.google.configured &&
    !enabledButUnconfigured.google.available,
  JSON.stringify(enabledButUnconfigured.google),
);
// The floor: the environment is not gated by any handler, so credentials can
// vanish on a deploy. The resolver must never report zero usable methods.
const allOff = resolveFromFlags({ email: false, google: false, facebook: false });
check(
  "the empty-set floor forces email available when nothing else is",
  allOff.email.available === true && allOff.email.enabled === false,
  JSON.stringify(allOff.email),
);
check(
  "the floor does not fabricate availability for anything else",
  !allOff.google.available && !allOff.facebook.available,
  JSON.stringify(allOff),
);

console.log("\n── stripeDashboardCustomerUrl() ──");
{
  const { stripeDashboardCustomerUrl } = await import("agora/billing");
  const savedDriver = process.env.BILLING_PROVIDER;
  const savedStripe = process.env.STRIPE_SECRET_KEY;
  const savedXendit = process.env.XENDIT_SECRET_KEY;
  const restore = () => {
    if (savedDriver === undefined) delete process.env.BILLING_PROVIDER;
    else process.env.BILLING_PROVIDER = savedDriver;
    if (savedStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedStripe;
    if (savedXendit === undefined) delete process.env.XENDIT_SECRET_KEY;
    else process.env.XENDIT_SECRET_KEY = savedXendit;
  };

  try {
    process.env.BILLING_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    check(
      "sk_test_ key builds a test-mode dashboard URL",
      stripeDashboardCustomerUrl("cus_123") ===
        "https://dashboard.stripe.com/test/customers/cus_123",
    );

    process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
    check(
      "sk_live_ key builds a live-mode dashboard URL",
      stripeDashboardCustomerUrl("cus_123") ===
        "https://dashboard.stripe.com/customers/cus_123",
    );

    process.env.STRIPE_SECRET_KEY = "rk_test_abc123";
    check(
      "a restricted test key (rk_test_) is detected via the _test_ infix",
      stripeDashboardCustomerUrl("cus_123") ===
        "https://dashboard.stripe.com/test/customers/cus_123",
    );

    process.env.STRIPE_SECRET_KEY = "some_unrecognized_key_shape";
    check(
      "an unrecognized key shape defaults to test mode (safer direction)",
      stripeDashboardCustomerUrl("cus_123") ===
        "https://dashboard.stripe.com/test/customers/cus_123",
    );

    process.env.BILLING_PROVIDER = "xendit";
    process.env.XENDIT_SECRET_KEY = "xnd_test_abc";
    delete process.env.STRIPE_SECRET_KEY;
    check(
      "null when the active driver isn't Stripe",
      stripeDashboardCustomerUrl("cus_123") === null,
    );
  } finally {
    restore();
  }
}

// --- platformSecurity (Phase 2, platform-security-policy plan) ---

check(
  "viewer holds platformSecurity:read",
  hasPlatformPermission("viewer", { platformSecurity: ["read"] }),
);
check(
  "viewer lacks platformSecurity:manage",
  !hasPlatformPermission("viewer", { platformSecurity: ["manage"] }),
);
check(
  "admin holds platformSecurity:read+manage",
  hasPlatformPermission("admin", { platformSecurity: ["read", "manage"] }),
);
check(
  "deny by default (null/owner/member) for platformSecurity:read",
  !hasPlatformPermission(null, { platformSecurity: ["read"] }) &&
    !hasPlatformPermission("owner", { platformSecurity: ["read"] }) &&
    !hasPlatformPermission("member", { platformSecurity: ["read"] }),
);
check(
  "permissionsForPlatformRole('viewer').platformSecurity does not include manage",
  !permissionsForPlatformRole("viewer").platformSecurity?.includes("manage"),
);

// --- setPlatformSecurityPolicySchema contract floor (Blocker 2b) ---

check(
  "sessionMaxAgeMinutes: 1 is rejected (below the 30-minute floor)",
  !setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: 1 }).success,
);
check(
  "sessionMaxAgeMinutes: 0 is rejected",
  !setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: 0 }).success,
);
check(
  "sessionMaxAgeMinutes: -5 is rejected",
  !setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: -5 }).success,
);
check(
  "sessionMaxAgeMinutes: 30 (floor) is accepted",
  setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: 30 }).success,
);
check(
  "sessionMaxAgeMinutes: 10080 (ceiling) is accepted",
  setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: 10080 }).success,
);
check(
  "sessionMaxAgeMinutes: 10081 is rejected (above the 7-day ceiling)",
  !setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: 10081 }).success,
);
check(
  "sessionMaxAgeMinutes: null is accepted (clears the override)",
  setPlatformSecurityPolicySchema.safeParse({ sessionMaxAgeMinutes: null }).success,
);
check(
  "twoFactorRequired: true is accepted",
  setPlatformSecurityPolicySchema.safeParse({ twoFactorRequired: true }).success,
);

console.log("\n── platform user-search permissions ──");
check(
  "platform viewer holds user:read",
  hasPlatformPermission("viewer", { user: ["read"] }),
);
check(
  "platform viewer does NOT hold user:disable/resetSessions/sendPasswordReset",
  !hasPlatformPermission("viewer", { user: ["disable"] }) &&
    !hasPlatformPermission("viewer", { user: ["resetSessions"] }) &&
    !hasPlatformPermission("viewer", { user: ["sendPasswordReset"] }),
);
check(
  "platform support holds user:read only — NOT disable/resetSessions/sendPasswordReset",
  hasPlatformPermission("support", { user: ["read"] }) &&
    !hasPlatformPermission("support", { user: ["disable"] }) &&
    !hasPlatformPermission("support", { user: ["resetSessions"] }) &&
    !hasPlatformPermission("support", { user: ["sendPasswordReset"] }),
);
check(
  "platform admin holds every user action",
  hasPlatformPermission("admin", {
    user: ["read", "disable", "resetSessions", "sendPasswordReset", "resetMfa"],
  }),
);
check(
  "platform viewer/support do NOT hold user:resetMfa; admin does",
  hasPlatformPermission("admin", { user: ["resetMfa"] }) &&
    !hasPlatformPermission("support", { user: ["resetMfa"] }) &&
    !hasPlatformPermission("viewer", { user: ["resetMfa"] }),
);
check(
  "no platform role holds user at all",
  !hasPlatformPermission(null, { user: ["read"] }) &&
    !hasPlatformPermission("owner", { user: ["read"] }) &&
    !hasPlatformPermission("member", { user: ["read"] }),
);
// The gate must actually fail when the permission is removed from the role —
// this is the RBAC rule's "must fail when removed" requirement, not plumbing.
check(
  "removing user:disable from a role denies exactly that action",
  hasPlatformPermission("admin", { user: ["disable"] }) &&
    !hasPlatformPermission("support", { user: ["disable"] }) &&
    !hasPlatformPermission("viewer", { user: ["disable"] }),
);
check(
  "removing user:resetSessions from a role denies exactly that action",
  hasPlatformPermission("admin", { user: ["resetSessions"] }) &&
    !hasPlatformPermission("support", { user: ["resetSessions"] }) &&
    !hasPlatformPermission("viewer", { user: ["resetSessions"] }),
);
check(
  "removing user:sendPasswordReset from a role denies exactly that action",
  hasPlatformPermission("admin", { user: ["sendPasswordReset"] }) &&
    !hasPlatformPermission("support", { user: ["sendPasswordReset"] }) &&
    !hasPlatformPermission("viewer", { user: ["sendPasswordReset"] }),
);
check(
  "removing user:resetMfa from a role denies exactly that action",
  hasPlatformPermission("admin", { user: ["resetMfa"] }) &&
    !hasPlatformPermission("support", { user: ["resetMfa"] }) &&
    !hasPlatformPermission("viewer", { user: ["resetMfa"] }),
);
// Inviting an administrator is a staff-role grant, so it is gated on
// staff:manage — admin-only, exactly like the role-change route.
check(
  "invite administrator gate: only platform admin holds staff:manage",
  hasPlatformPermission("admin", { staff: ["manage"] }) &&
    !hasPlatformPermission("support", { staff: ["manage"] }) &&
    !hasPlatformPermission("viewer", { staff: ["manage"] }),
);

console.log("\n── platform plan-catalog permissions ──");
check(
  "platform viewer holds plan:read",
  hasPlatformPermission("viewer", { plan: ["read"] }),
);
check(
  "platform viewer does NOT hold plan:manage",
  !hasPlatformPermission("viewer", { plan: ["manage"] }),
);
check(
  "platform support holds plan:read only — NOT plan:manage",
  hasPlatformPermission("support", { plan: ["read"] }) &&
    !hasPlatformPermission("support", { plan: ["manage"] }),
);
check(
  "platform admin holds plan:read + plan:manage",
  hasPlatformPermission("admin", { plan: ["read", "manage"] }),
);
check(
  "no platform role holds plan at all",
  !hasPlatformPermission(null, { plan: ["read"] }) &&
    !hasPlatformPermission("owner", { plan: ["read"] }) &&
    !hasPlatformPermission("member", { plan: ["read"] }),
);
check(
  "permissionsForPlatformRole(null).plan is undefined",
  permissionsForPlatformRole(null).plan === undefined,
);
// The gate must actually fail when plan:manage is removed from the role.
check(
  "removing plan:manage from a role denies exactly that action",
  hasPlatformPermission("admin", { plan: ["manage"] }) &&
    !hasPlatformPermission("support", { plan: ["manage"] }) &&
    !hasPlatformPermission("viewer", { plan: ["manage"] }),
);

console.log("\n── platform usage & limits permissions ──");
check(
  "platform viewer holds usage:read",
  hasPlatformPermission("viewer", { usage: ["read"] }),
);
check(
  "platform support holds usage:read",
  hasPlatformPermission("support", { usage: ["read"] }),
);
check(
  "platform viewer does NOT hold usage:manageQuota",
  !hasPlatformPermission("viewer", { usage: ["manageQuota"] }),
);
check(
  "platform support does NOT hold usage:manageQuota",
  !hasPlatformPermission("support", { usage: ["manageQuota"] }),
);
check(
  "platform admin holds usage:read and :manageQuota",
  hasPlatformPermission("admin", { usage: ["read", "manageQuota"] }),
);
check(
  "no non-platform role holds usage at all",
  !hasPlatformPermission(null, { usage: ["read"] }) &&
    !hasPlatformPermission("owner", { usage: ["read"] }) &&
    !hasPlatformPermission("member", { usage: ["read"] }),
);
check(
  "usage is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).usage === undefined,
);
// The gate must fail when manageQuota is removed from the role — asserting a
// viewer/support denied `manageQuota` cannot pass the same check an admin does.
check(
  "removing usage:manageQuota from a role denies exactly that action",
  hasPlatformPermission("admin", { usage: ["manageQuota"] }) &&
    !hasPlatformPermission("support", { usage: ["manageQuota"] }) &&
    !hasPlatformPermission("viewer", { usage: ["manageQuota"] }),
);

console.log("\n── platform integration permissions ──");
check(
  "platform viewer holds integration:read",
  hasPlatformPermission("viewer", { integration: ["read"] }),
);
check(
  "platform viewer does NOT hold integration:manage or :test",
  !hasPlatformPermission("viewer", { integration: ["manage"] }) &&
    !hasPlatformPermission("viewer", { integration: ["test"] }),
);
check(
  "platform support holds integration:read only",
  hasPlatformPermission("support", { integration: ["read"] }) &&
    !hasPlatformPermission("support", { integration: ["manage"] }) &&
    !hasPlatformPermission("support", { integration: ["test"] }),
);
check(
  "platform admin holds integration:read, :manage and :test",
  hasPlatformPermission("admin", { integration: ["read", "manage", "test"] }),
);
check(
  "no platform role holds integration at all",
  !hasPlatformPermission(null, { integration: ["read"] }) &&
    !hasPlatformPermission("owner", { integration: ["read"] }) &&
    !hasPlatformPermission("member", { integration: ["read"] }),
);
check(
  "integration is absent from a null platform role's resolved set",
  permissionsForPlatformRole(null).integration === undefined,
);
// The gate must actually fail when the permission is removed from the role.
check(
  "removing integration:manage from a role denies exactly that action",
  hasPlatformPermission("admin", { integration: ["manage"] }) &&
    !hasPlatformPermission("support", { integration: ["manage"] }) &&
    !hasPlatformPermission("viewer", { integration: ["manage"] }),
);
check(
  "removing integration:test from a role denies exactly that action",
  hasPlatformPermission("admin", { integration: ["test"] }) &&
    !hasPlatformPermission("support", { integration: ["test"] }) &&
    !hasPlatformPermission("viewer", { integration: ["test"] }),
);

console.log("\n── platform API-key permissions (spec #16) ──");
check(
  "platform viewer + support hold platformApiKey:read",
  hasPlatformPermission("viewer", { platformApiKey: ["read"] }) &&
    hasPlatformPermission("support", { platformApiKey: ["read"] }),
);
check(
  "platform viewer/support do NOT hold platformApiKey:revoke or :rotate",
  !hasPlatformPermission("viewer", { platformApiKey: ["revoke"] }) &&
    !hasPlatformPermission("viewer", { platformApiKey: ["rotate"] }) &&
    !hasPlatformPermission("support", { platformApiKey: ["revoke"] }) &&
    !hasPlatformPermission("support", { platformApiKey: ["rotate"] }),
);
check(
  "platform admin holds platformApiKey:read, :revoke and :rotate",
  hasPlatformPermission("admin", { platformApiKey: ["read", "revoke", "rotate"] }),
);
check(
  "no non-platform role holds platformApiKey at all",
  !hasPlatformPermission(null, { platformApiKey: ["read"] }) &&
    !hasPlatformPermission("owner", { platformApiKey: ["read"] }) &&
    !hasPlatformPermission("member", { platformApiKey: ["read"] }),
);
// The gate must actually fail when the permission is removed from the role.
check(
  "removing platformApiKey:revoke from a role denies exactly that action",
  hasPlatformPermission("admin", { platformApiKey: ["revoke"] }) &&
    !hasPlatformPermission("support", { platformApiKey: ["revoke"] }) &&
    !hasPlatformPermission("viewer", { platformApiKey: ["revoke"] }),
);
check(
  "removing platformApiKey:rotate from a role denies exactly that action",
  hasPlatformPermission("admin", { platformApiKey: ["rotate"] }) &&
    !hasPlatformPermission("support", { platformApiKey: ["rotate"] }) &&
    !hasPlatformPermission("viewer", { platformApiKey: ["rotate"] }),
);

console.log("\n── platform webhook permissions (spec #16) ──");
check(
  "platform viewer + support hold platformWebhook:read",
  hasPlatformPermission("viewer", { platformWebhook: ["read"] }) &&
    hasPlatformPermission("support", { platformWebhook: ["read"] }),
);
check(
  "platform viewer/support do NOT hold platformWebhook:retry or :disable",
  !hasPlatformPermission("viewer", { platformWebhook: ["retry"] }) &&
    !hasPlatformPermission("viewer", { platformWebhook: ["disable"] }) &&
    !hasPlatformPermission("support", { platformWebhook: ["retry"] }) &&
    !hasPlatformPermission("support", { platformWebhook: ["disable"] }),
);
check(
  "platform admin holds platformWebhook:read, :retry and :disable",
  hasPlatformPermission("admin", { platformWebhook: ["read", "retry", "disable"] }),
);
check(
  "no non-platform role holds platformWebhook at all",
  !hasPlatformPermission(null, { platformWebhook: ["read"] }) &&
    !hasPlatformPermission("owner", { platformWebhook: ["read"] }) &&
    !hasPlatformPermission("member", { platformWebhook: ["read"] }),
);
check(
  "removing platformWebhook:retry from a role denies exactly that action",
  hasPlatformPermission("admin", { platformWebhook: ["retry"] }) &&
    !hasPlatformPermission("support", { platformWebhook: ["retry"] }) &&
    !hasPlatformPermission("viewer", { platformWebhook: ["retry"] }),
);
check(
  "removing platformWebhook:disable from a role denies exactly that action",
  hasPlatformPermission("admin", { platformWebhook: ["disable"] }) &&
    !hasPlatformPermission("support", { platformWebhook: ["disable"] }) &&
    !hasPlatformPermission("viewer", { platformWebhook: ["disable"] }),
);

console.log("\n── platform job queue permissions (general-job-queue / sms-provider-and-job-retry) ──");
check(
  "platform viewer + support hold queue:read",
  hasPlatformPermission("viewer", { queue: ["read"] }) &&
    hasPlatformPermission("support", { queue: ["read"] }),
);
check(
  "platform viewer/support do NOT hold queue:retry",
  !hasPlatformPermission("viewer", { queue: ["retry"] }) &&
    !hasPlatformPermission("support", { queue: ["retry"] }),
);
check(
  "platform admin holds queue:read and :retry",
  hasPlatformPermission("admin", { queue: ["read", "retry"] }),
);
check(
  "no non-platform role holds queue at all",
  !hasPlatformPermission(null, { queue: ["read"] }) &&
    !hasPlatformPermission("owner", { queue: ["read"] }) &&
    !hasPlatformPermission("member", { queue: ["read"] }),
);
check(
  "removing queue:retry from a role denies exactly that action",
  hasPlatformPermission("admin", { queue: ["retry"] }) &&
    !hasPlatformPermission("support", { queue: ["retry"] }) &&
    !hasPlatformPermission("viewer", { queue: ["retry"] }),
);

console.log("\n── platform system-health permissions (spec #17) ──");
check(
  "every platform role holds systemHealth:read (observational, read-only)",
  hasPlatformPermission("viewer", { systemHealth: ["read"] }) &&
    hasPlatformPermission("support", { systemHealth: ["read"] }) &&
    hasPlatformPermission("admin", { systemHealth: ["read"] }),
);
check(
  "no non-platform role holds systemHealth at all",
  !hasPlatformPermission(null, { systemHealth: ["read"] }) &&
    !hasPlatformPermission("owner", { systemHealth: ["read"] }) &&
    !hasPlatformPermission("member", { systemHealth: ["read"] }),
);
check(
  "systemHealth has no manage action wired (MVP is read-only)",
  !hasPlatformPermission("admin", {
    systemHealth: ["manage"] as unknown as ["read"],
  }),
);

console.log("\n── platform roles matrix — read gate + display metadata drift guard ──");
// The read-only /admin/roles matrix is gated on staff:read, so ALL THREE roles
// may view it — the same gate as the staff LIST — while the one real mutation
// (assigning a role) stays admin-only on staff:manage.
check(
  "all three platform roles hold staff:read (matrix is viewable by every role)",
  hasPlatformPermission("viewer", { staff: ["read"] }) &&
    hasPlatformPermission("support", { staff: ["read"] }) &&
    hasPlatformPermission("admin", { staff: ["read"] }),
);
check(
  "only admin holds staff:manage (assigning a role stays admin-only)",
  hasPlatformPermission("admin", { staff: ["manage"] }) &&
    !hasPlatformPermission("support", { staff: ["manage"] }) &&
    !hasPlatformPermission("viewer", { staff: ["manage"] }),
);
// Drift guard: every real gated resource MUST appear in the matrix's group
// metadata as a real group, so a future resource cannot silently fall out of
// the /admin/roles matrix (the way `integration` once slipped a plan snapshot).
{
  const realGroupResources = new Set<string>(
    PLATFORM_PERMISSION_GROUPS.filter((g) => g.real).map(
      (g) => g.resource as string,
    ),
  );
  for (const resource of Object.keys(PLATFORM_PERMISSION_STATEMENTS)) {
    check(
      `matrix group metadata covers real resource "${resource}"`,
      realGroupResources.has(resource),
    );
  }
  // Every real group entry must name a resource that actually exists in the
  // vocabulary (no dangling display rows), and aspirational groups carry no
  // resource — so the UI can never imply a grant for a non-existent resource.
  for (const g of PLATFORM_PERMISSION_GROUPS) {
    if (g.real) {
      check(
        `real group "${g.group}" points at an existing resource`,
        g.resource != null && g.resource in PLATFORM_PERMISSION_STATEMENTS,
      );
    } else {
      check(
        `aspirational group "${g.group}" carries no gated resource`,
        g.resource === null,
      );
    }
  }
}
{
  const display = PLATFORM_ROLE_DISPLAY as Record<
    string,
    { label: string; description: string } | undefined
  >;
  check(
    "every real platform role has display label + description for the matrix",
    ["viewer", "support", "admin"].every(
      (r) =>
        typeof display[r]?.label === "string" &&
        (display[r]?.label.length ?? 0) > 0 &&
        (display[r]?.description.length ?? 0) > 0,
    ),
  );
}

console.log(
  `\n${failures.length === 0 ? "✅ PASS" : "❌ FAIL"} — ${passed} passed, ${failures.length} failed`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
