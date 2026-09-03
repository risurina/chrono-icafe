"use client";

import { useEffect, useState } from "react";
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
  Can,
  can,
} from "agora/ui";
import { api } from "@/lib/rpc";

type PermissionMap = Record<string, string[]>;
type Role = {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionMap;
  memberCount: number;
};
type Me = { role: string; permissions: PermissionMap };

/** Turn "featureFlag" / "apiKey" into "Feature flag" / "Api key". */
function humanize(resource: string): string {
  const spaced = resource.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const EMPTY_DRAFT = { key: "", name: "", description: "", permissions: {} as PermissionMap };

export default function RolesSettingsPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionMap>({});
  const [me, setMe] = useState<Me | null>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadAll() {
    const [r, cat, meRes] = await Promise.all([
      api.rpc.roles.$get(),
      api.rpc.roles.catalog.$get(),
      api.rpc.me.$get(),
    ]);
    if (r.ok) setRoles((await r.json()).roles as Role[]);
    if (cat.ok) setCatalog((await cat.json()).catalog as PermissionMap);
    if (meRes.ok) {
      const body = (await meRes.json()) as Me;
      setMe({ role: body.role, permissions: body.permissions ?? {} });
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const canManage = can(me?.permissions, "role", "manage");

  /** An actor may only grant what they hold — mirror the server guard in the UI
   *  so an ungrantable box is disabled rather than failing on save. */
  const holds = (resource: string, action: string) =>
    (me?.permissions[resource] ?? []).includes(action);

  function toggle(resource: string, action: string, on: boolean) {
    setDraft((d) => {
      const current = new Set(d.permissions[resource] ?? []);
      if (on) current.add(action);
      else current.delete(action);
      const next = { ...d.permissions };
      if (current.size > 0) next[resource] = [...current];
      else delete next[resource];
      return { ...d, permissions: next };
    });
  }

  function startEdit(role: Role) {
    setEditing(role.key);
    setDraft({
      key: role.key,
      name: role.name,
      description: role.description ?? "",
      permissions: role.permissions,
    });
    setMsg(null);
  }

  /** Clear the form back to "new role" WITHOUT touching `msg` — a save calls
   *  this right after setting its success message, and clearing it here would
   *  wipe the only confirmation the user ever sees. */
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
        ? await api.rpc.roles[":key"].$patch({
            param: { key: editing },
            json: {
              name: draft.name,
              description: draft.description || null,
              permissions: draft.permissions,
            },
          })
        : await api.rpc.roles.$post({
            json: {
              key: draft.key,
              name: draft.name,
              description: draft.description || undefined,
              permissions: draft.permissions,
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
    const res = await api.rpc.roles[":key"].$delete({ param: { key } });
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
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            {canManage
              ? "Built-in roles are fixed. Create custom roles to grant a precise set of permissions."
              : "You don't have permission to manage roles."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={2}>
            {roles.map((r) => (
              <Row key={r.key} items="center" className="justify-between rounded-md border p-3">
                <Stack gap={1}>
                  <Row items="center">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge variant={r.isSystem ? "secondary" : "outline"}>
                      {r.isSystem ? "Built-in" : r.key}
                    </Badge>
                  </Row>
                  <span className="text-xs text-muted-foreground">
                    {r.description ??
                      (r.isSystem ? "Defined in code and not editable." : "No description.")}
                    {" · "}
                    {r.memberCount} member{r.memberCount === 1 ? "" : "s"}
                  </span>
                </Stack>
                <Row shrink items="center">
                  {r.isSystem ? null : (
                    <Can permissions={me?.permissions} resource="role" action="manage">
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
                    </Can>
                  )}
                </Row>
              </Row>
            ))}
            {roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No roles yet.</p>
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      <Can permissions={me?.permissions} resource="role" action="manage">
        <form onSubmit={save}>
          <Card>
            <CardHeader>
              <CardTitle>{editing ? `Edit “${draft.name || editing}”` : "New role"}</CardTitle>
              <CardDescription>
                You can only grant permissions you hold yourself — anything above your own
                access is disabled.
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
                        placeholder="billing-manager"
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
                      placeholder="Billing Manager"
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
                  {Object.entries(catalog).map(([resource, actions]) => (
                    <Row key={resource} items="center" className="justify-between rounded-md border p-3">
                      <span className="text-sm">{humanize(resource)}</span>
                      <Row shrink items="center" className="flex-wrap justify-end gap-3">
                        {actions.map((action) => {
                          const granted = (draft.permissions[resource] ?? []).includes(action);
                          const allowed = holds(resource, action);
                          return (
                            <Row key={action} shrink items="center" className="gap-1.5">
                              <Switch
                                id={`${resource}-${action}`}
                                checked={granted}
                                disabled={!allowed}
                                onCheckedChange={(v: boolean) => toggle(resource, action, v)}
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
                {msg ? <span className="text-sm text-muted-foreground">{msg}</span> : null}
              </Row>
            </CardFooter>
          </Card>
        </form>
      </Can>
    </Stack>
  );
}
