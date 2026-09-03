"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Input,
  Textarea,
  Label,
  Badge,
  Switch,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Stack,
  Row,
  Field,
  can,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformCustomRole } from "agora";

type PermissionMap = Record<string, string[]>;

/** "featureFlag" / "apiKey" → "Feature flag" / "Api key". */
function humanize(resource: string): string {
  const spaced = resource.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const EMPTY_DRAFT = { key: "", name: "", description: "", permission: {} as PermissionMap };

/**
 * Platform custom-role editor (`/rpc-admin/staff/roles`). Custom roles are a
 * third tier beyond the code-defined `viewer`/`support`/`admin`, composed from
 * the same `PLATFORM_PERMISSION_STATEMENTS` vocabulary the server enforces —
 * fetched here as data (`GET /rpc-admin/roles`.statements), never imported,
 * since `agora/auth` is server-only. The server is the real gate
 * (`staff:manage`); these controls are visibility only. Client-side list at
 * this cardinality (a handful of roles) per `.ai/rules/data-listing.md`.
 */
export default function PlatformRolesPage() {
  const [roles, setRoles] = useState<PlatformCustomRole[]>([]);
  const [statements, setStatements] = useState<PermissionMap>({});
  const [myPerms, setMyPerms] = useState<PermissionMap>({});
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadAll() {
    const [rolesRes, matrixRes, meRes] = await Promise.all([
      adminApi["rpc-admin"].staff.roles.$get(),
      adminApi["rpc-admin"].roles.$get(),
      adminApi["rpc-admin"].me.$get(),
    ]);
    if (rolesRes.ok) setRoles((await rolesRes.json()).items as PlatformCustomRole[]);
    if (matrixRes.ok) setStatements((await matrixRes.json()).statements as PermissionMap);
    if (meRes.ok) setMyPerms((await meRes.json()).permissions ?? {});
  }

  useEffect(() => {
    loadAll();
  }, []);

  const canManage = can(myPerms, "staff", "manage");

  /** An actor may only grant what they hold — mirror the server guard so an
   *  ungrantable box is disabled rather than failing on save. */
  const holds = (resource: string, action: string) =>
    (myPerms[resource] ?? []).includes(action);

  function toggle(resource: string, action: string, on: boolean) {
    setDraft((d) => {
      const current = new Set(d.permission[resource] ?? []);
      if (on) current.add(action);
      else current.delete(action);
      const next = { ...d.permission };
      if (current.size > 0) next[resource] = [...current];
      else delete next[resource];
      return { ...d, permission: next };
    });
  }

  function startEdit(role: PlatformCustomRole) {
    setEditing(role.key);
    setDraft({
      key: role.key,
      name: role.name,
      description: role.description ?? "",
      permission: role.permission,
    });
    setMsg(null);
  }

  /** Reset to "new role" WITHOUT touching `msg` — a save calls this right after
   *  setting its success message. */
  function resetDraft() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  function startCreate() {
    resetDraft();
    setMsg(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = editing
        ? await adminApi["rpc-admin"].staff.roles[":key"].$patch({
            param: { key: editing },
            json: {
              name: draft.name,
              description: draft.description || null,
              permission: draft.permission,
            },
          })
        : await adminApi["rpc-admin"].staff.roles.$post({
            json: {
              key: draft.key,
              name: draft.name,
              description: draft.description || undefined,
              permission: draft.permission,
            },
          });
      if (res.ok) {
        setMsg(editing ? "Role updated." : "Role created.");
        resetDraft();
        await loadAll();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg(body?.error ?? "Could not save the role.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    setMsg(null);
    const res = await adminApi["rpc-admin"].staff.roles[":key"].$delete({
      param: { key },
    });
    if (res.ok) {
      setMsg("Role deleted.");
      if (editing === key) resetDraft();
      await loadAll();
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setMsg(body?.error ?? "Could not delete the role.");
    }
  }

  return (
    <Stack gap={8}>
      <Card>
        <CardHeader>
          <CardTitle>Custom platform roles</CardTitle>
          <CardDescription>
            The built-in{" "}
            <Link href="/admin/roles" className="underline">
              viewer / support / admin
            </Link>{" "}
            roles are fixed in code. Create custom roles to grant a precise set of
            platform permissions, then assign them from{" "}
            <Link href="/admin/staff" className="underline">
              Administrators
            </Link>
            . Custom roles rank at the floor — they can never grant or manage an admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={2}>
            {roles.map((r) => (
              <Row
                key={r.key}
                items="center"
                className="justify-between rounded-md border p-3"
              >
                <Stack gap={1}>
                  <Row items="center">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge variant="outline">{r.key}</Badge>
                  </Row>
                  <span className="text-xs text-muted-foreground">
                    {r.description ?? "No description."}
                    {" · "}
                    {Object.keys(r.permission).length} resource
                    {Object.keys(r.permission).length === 1 ? "" : "s"}
                  </span>
                </Stack>
                {canManage ? (
                  <Row shrink items="center">
                    <Button variant="outline" size="sm" onClick={() => startEdit(r)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => remove(r.key)}
                    >
                      Delete
                    </Button>
                  </Row>
                ) : null}
              </Row>
            ))}
            {roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No custom roles yet.</p>
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      {canManage ? (
        <form onSubmit={save}>
          <Card>
            <CardHeader>
              <CardTitle>
                {editing ? `Edit “${draft.name || editing}”` : "New custom role"}
              </CardTitle>
              <CardDescription>
                You can only grant permissions you hold yourself — anything above your
                own access is disabled.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Stack gap={4}>
                <Row items="start">
                  {editing ? null : (
                    <Field>
                      <Label htmlFor="role-key">Key</Label>
                      <Input
                        id="role-key"
                        placeholder="support-billing"
                        value={draft.key}
                        onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                        required
                      />
                    </Field>
                  )}
                  <Field>
                    <Label htmlFor="role-name">Name</Label>
                    <Input
                      id="role-name"
                      placeholder="Support (billing)"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      required
                    />
                  </Field>
                </Row>
                <Field>
                  <Label htmlFor="role-description">Description</Label>
                  <Textarea
                    id="role-description"
                    placeholder="What this role is for."
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </Field>

                <Stack gap={2}>
                  <Label>Permissions</Label>
                  {Object.entries(statements).map(([resource, actions]) => (
                    <Row
                      key={resource}
                      items="center"
                      className="justify-between rounded-md border p-3"
                    >
                      <span className="text-sm">{humanize(resource)}</span>
                      <Row shrink items="center" className="flex-wrap justify-end gap-3">
                        {actions.map((action) => {
                          const granted = (draft.permission[resource] ?? []).includes(
                            action,
                          );
                          const allowed = holds(resource, action);
                          return (
                            <Row key={action} shrink items="center" className="gap-1.5">
                              <Switch
                                id={`${resource}-${action}`}
                                checked={granted}
                                disabled={!allowed}
                                onCheckedChange={(v: boolean) =>
                                  toggle(resource, action, v)
                                }
                              />
                              <Label
                                htmlFor={`${resource}-${action}`}
                                className="text-xs font-normal text-muted-foreground"
                              >
                                {action}
                              </Label>
                            </Row>
                          );
                        })}
                      </Row>
                    </Row>
                  ))}
                </Stack>
              </Stack>
            </CardContent>
            <CardFooter>
              <Row items="center">
                <Button type="submit" disabled={busy}>
                  {editing ? "Save changes" : "Create role"}
                </Button>
                {editing ? (
                  <Button type="button" variant="ghost" onClick={startCreate}>
                    Cancel
                  </Button>
                ) : null}
                {msg ? (
                  <span className="text-sm text-muted-foreground">{msg}</span>
                ) : null}
              </Row>
            </CardFooter>
          </Card>
        </form>
      ) : null}
    </Stack>
  );
}
