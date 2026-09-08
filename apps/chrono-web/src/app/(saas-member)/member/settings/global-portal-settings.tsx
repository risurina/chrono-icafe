"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Label,
  Input,
  Button,
  ThemeToggle,
  Row,
  Stack,
  toast,
} from "agora/ui";
import { customerAuth, useGlobalCustomerSession } from "@/lib/customer-client";

/**
 * Global customer settings page — replaces the old `/member/profile` "Your
 * account" read-only card. Mirrors the tenant member area's own
 * `/member/settings` (`(tenant-member)/player/settings/page.tsx`): Edit
 * Profile Details, Change/Set password, Appearance, Account. Uses the global
 * `customerAuth` client (platform-wide identity), not `memberAuth`.
 */
export function GlobalPortalSettings() {
  const { customer } = useGlobalCustomerSession();
  const [name, setName] = useState(customer?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Undefined only while the session is still loading — default to `true` so
  // the always-safe "Change password" form is what briefly flashes, never
  // the more permissive "Set a password" one. Mirrors the tenant Profile
  // page's identical default.
  const hasPassword = customer?.hasPassword ?? true;

  useEffect(() => {
    setName(customer?.name ?? "");
  }, [customer?.name]);

  async function onSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSavingName(true);
    const { error } = await customerAuth.updateProfile({ name: name.trim() });
    setSavingName(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Profile updated.");
  }

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setSavingPassword(true);
    const { error } = hasPassword
      ? await customerAuth.changePassword({ currentPassword, newPassword })
      : await customerAuth.setPassword({ newPassword });
    setSavingPassword(false);
    if (error) {
      toast.error(error);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setIsChangingPassword(false);
    toast.success(
      hasPassword
        ? "Password changed. You've been signed out of your other sessions."
        : "Password set. You can now sign in with it directly.",
    );
  }

  async function onSignOut() {
    setSigningOut(true);
    await customerAuth.signOut();
    location.href = "/member/login";
  }

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          One account, usable across every business you join.
        </p>
      </div>

      <Card>
        <form onSubmit={onSaveProfile}>
          <CardHeader>
            <CardTitle>Edit Profile Details</CardTitle>
            <CardDescription>Update your name.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="name">Full Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input id="email" type="email" value={customer?.email ?? ""} disabled />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={savingName}>
              {savingName ? "Saving…" : "Save changes"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <form onSubmit={onChangePassword}>
          <CardHeader>
            <Row items="center" className="justify-between">
              <Stack gap={0}>
                <CardTitle>{hasPassword ? "Change password" : "Set a password"}</CardTitle>
                <CardDescription>
                  {hasPassword
                    ? "Changing your password signs you out of every other session."
                    : "You signed up with a social account — set a password to also sign in directly."}
                </CardDescription>
              </Stack>
              {!isChangingPassword ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsChangingPassword(true)}
                >
                  {hasPassword ? "Change password" : "Set a password"}
                </Button>
              ) : null}
            </Row>
          </CardHeader>
          {isChangingPassword ? (
            <>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  {hasPassword ? (
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="currentPassword">Current password</Label>
                      <Input
                        id="currentPassword"
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        required
                      />
                    </div>
                  ) : null}
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="newPassword">New password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={8}
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Row gap={2}>
                  <Button type="submit" disabled={savingPassword}>
                    {savingPassword ? "Saving…" : hasPassword ? "Change password" : "Set password"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsChangingPassword(false);
                      setCurrentPassword("");
                      setNewPassword("");
                    }}
                  >
                    Cancel
                  </Button>
                </Row>
              </CardFooter>
            </>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how the account area looks.</CardDescription>
        </CardHeader>
        <CardContent>
          <Row items="center" gap={3}>
            <span className="text-sm text-muted-foreground">Theme</span>
            <ThemeToggle />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Sign out of your account on this device.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" onClick={onSignOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </CardFooter>
      </Card>
    </Stack>
  );
}
