"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  buttonVariants,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Grid,
  Row,
  Stack,
  Separator,
  CenteredMessage,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformRole, PlatformRolesMatrixResponse } from "agora";

// Mirrors PLATFORM_ROLE_KEYS (packages/agora/src/auth/platform-permissions.ts) —
// hardcoded here rather than imported, since "agora/auth" pulls server-only
// Better Auth config into the client bundle (see .ai/rules/architecture.md).
const ROLE_ORDER: PlatformRole[] = ["admin", "support", "viewer"];
const ROLE_BADGE_VARIANT: Record<PlatformRole, "default" | "secondary"> = {
  admin: "default",
  support: "secondary",
  viewer: "secondary",
};

// Read actions render muted; destructive / incident actions render as
// destructive; everything else is a neutral write. This is presentation only —
// the grant itself comes verbatim from PLATFORM_ROLES via the API.
const VIEW_ACTIONS = new Set(["read", "policyRead"]);
const DESTRUCTIVE_ACTIONS = new Set([
  "suspend",
  "archive",
  "revoke",
  "disable",
  "delete",
  "force-end",
  "refund",
  "rotate",
  "resetMfa",
  "resetSessions",
]);

function actionVariant(action: string): "secondary" | "destructive" | "outline" {
  if (VIEW_ACTIONS.has(action)) return "secondary";
  if (DESTRUCTIVE_ACTIONS.has(action)) return "destructive";
  return "outline";
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Roles & permissions — a READ-ONLY visualization of the code-defined
 * platform-admin RBAC (PLATFORM_PERMISSION_STATEMENTS × PLATFORM_ROLES). The
 * three roles are code, not database rows, so there is no editor, no delete
 * affordance, and no role-authoring here — the one real mutation (assigning a
 * role to a user) lives at /admin/staff, which this page only links to.
 * Viewable by every platform role (gated staff:read, like the staff list).
 */
export default function PlatformRolesPage() {
  const [data, setData] = useState<PlatformRolesMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);


  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await adminApi["rpc-admin"].roles.$get();
      if (!res.ok) {
        if (!cancelled) { setError("Failed to load roles & permissions."); toast.error("Failed to load roles & permissions."); }
        return;
      }
      const body = await res.json();
      if (!cancelled) setData(body as PlatformRolesMatrixResponse);
    })().catch(() => {
      if (!cancelled) { setError("Failed to load roles & permissions."); toast.error("Failed to load roles & permissions."); }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Stack><p>Loading...</p></Stack>
    );
  }
  if (!data) return <CenteredMessage>Loading…</CenteredMessage>;

  const { roles, statements, groups, assignedCounts, aspirationalRoles, recentRoleActivity } =
    data;
  const rolesByKey = new Map(roles.map((r) => [r.key, r]));

  // Order matrix rows by the (real) permission-group order, appending any
  // resource missing from the group metadata as a safety net.
  const groupedResources = groups
    .filter((g) => g.real && g.resource)
    .map((g) => ({ group: g.group, resource: g.resource as string }))
    .filter((g) => statements[g.resource]);
  const seen = new Set(groupedResources.map((g) => g.resource));
  for (const resource of Object.keys(statements)) {
    if (!seen.has(resource)) groupedResources.push({ group: resource, resource });
  }

  return (
    <Stack>
      <Card>
        <CardHeader>
          <CardTitle>Roles &amp; permissions</CardTitle>
          <CardDescription>
            A read-only view of the platform-admin access model. Roles are defined in
            code (not editable here), so they cannot be created, renamed, or deleted —
            adding a role is a code change, exactly as the Support role was added. To
            assign a role to an administrator, use{" "}
            <Link href="/admin/staff" className="underline">
              Administrators
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>

      {/* System roles */}
      <Stack gap={3}>
        <CardTitle>System roles</CardTitle>
        <Grid cols={3}>
          {ROLE_ORDER.map((key) => {
            const role = rolesByKey.get(key);
            if (!role) return null;
            const grantedResourceCount = Object.values(role.grants).filter(
              (a) => a.length > 0,
            ).length;
            return (
              <Card key={key}>
                <CardHeader>
                  <Row items="center" justify="between">
                    <CardTitle>{role.label}</CardTitle>
                    <Badge variant={ROLE_BADGE_VARIANT[key]}>{key}</Badge>
                  </Row>
                  <CardDescription>{role.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Stack gap={2}>
                    <Row items="baseline" gap={2}>
                      <span className="text-2xl font-semibold">
                        {assignedCounts[key] ?? 0}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        assigned {(assignedCounts[key] ?? 0) === 1 ? "admin" : "admins"}
                      </span>
                    </Row>
                    <span className="text-xs text-muted-foreground">
                      Grants access to {grantedResourceCount} of{" "}
                      {Object.keys(statements).length} resources.
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Code-defined — cannot be deleted.
                    </span>
                  </Stack>
                </CardContent>
                <CardFooter>
                  <Link
                    href="/admin/staff"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Manage assignments
                  </Link>
                </CardFooter>
              </Card>
            );
          })}
        </Grid>

        {aspirationalRoles.map((r) => (
          <Card key={r.label} className="border-dashed opacity-80">
            <CardHeader>
              <Row items="center" justify="between">
                <CardTitle className="text-muted-foreground">{r.label}</CardTitle>
                <Badge variant="outline">aspirational</Badge>
              </Row>
              <CardDescription>{r.note}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </Stack>

      {/* Permission matrix */}
      <Card>
        <CardHeader>
          <CardTitle>Permission matrix</CardTitle>
          <CardDescription>
            Every gated resource and the exact actions each role holds, read straight
            from the code. A cell shows only the actions that role actually has —{" "}
            <Badge variant="secondary">read</Badge> is a view action,{" "}
            <Badge variant="destructive">destructive</Badge> is a high-impact one,{" "}
            <Badge variant="outline">write</Badge> is everything else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  {ROLE_ORDER.map((key) => (
                    <TableHead key={key}>{key}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupedResources.map(({ group, resource }) => (
                  <TableRow key={resource}>
                    <TableCell>
                      <Stack gap={0}>
                        <span className="font-medium">{group}</span>
                        <span className="text-xs text-muted-foreground">{resource}</span>
                      </Stack>
                    </TableCell>
                    {ROLE_ORDER.map((key) => {
                      const held = rolesByKey.get(key)?.grants[resource] ?? [];
                      return (
                        <TableCell key={key}>
                          {held.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Row wrap gap={1}>
                              {held.map((action) => (
                                <Badge key={action} variant={actionVariant(action)}>
                                  {action}
                                </Badge>
                              ))}
                            </Row>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Permission groups (spec mapping) */}
      <Card>
        <CardHeader>
          <CardTitle>Permission groups</CardTitle>
          <CardDescription>
            How the product spec&apos;s permission groups map onto the real gated
            resources. Groups marked aspirational have no gated resource today — they
            are shown for transparency, not as active grants.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Backing resource</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.group}>
                    <TableCell className="font-medium">{g.group}</TableCell>
                    <TableCell>
                      {g.resource ? (
                        <code className="text-xs">{g.resource}</code>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={g.real ? "secondary" : "outline"}>
                        {g.real ? "real" : "aspirational"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {g.note}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Recent role activity */}
      <Card>
        <CardHeader>
          <Row items="center" justify="between">
            <Stack gap={1}>
              <CardTitle>Recent role activity</CardTitle>
              <CardDescription>The latest platform-role assignments.</CardDescription>
            </Stack>
            <Link
              href="/admin/audit?action=platform.staff.roleChanged"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              View full audit log
            </Link>
          </Row>
        </CardHeader>
        <CardContent>
          {recentRoleActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No role changes recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRoleActivity.map((e) => {
                    const meta = (e.metadata ?? {}) as Record<string, unknown>;
                    const from =
                      (meta.previousRole as string | null) ??
                      (meta.before as string | null) ??
                      null;
                    const to =
                      (meta.role as string | null) ??
                      (meta.after as string | null) ??
                      null;
                    return (
                      <TableRow key={e.id}>
                        <TableCell>{e.actorLabel ?? e.actorId ?? "—"}</TableCell>
                        <TableCell>{e.targetLabel ?? e.targetId ?? "—"}</TableCell>
                        <TableCell>
                          <Row items="center" gap={1}>
                            <Badge variant="outline">{from ?? "none"}</Badge>
                            <span aria-hidden>→</span>
                            <Badge variant="secondary">{to ?? "none"}</Badge>
                          </Row>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {fmt(e.createdAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />
      <p className="text-xs text-muted-foreground">
        This page is read-only. Roles and their permissions are defined in code
        (PLATFORM_ROLES); changing them is a code change, not a database edit.
      </p>
    </Stack>
  );
}
