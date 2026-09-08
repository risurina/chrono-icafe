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
import { memberAuth } from "@/lib/member-client";
import { useMemberArea } from "@/components/member/member-area-context";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { NeedHelpLinks } from "@/components/member/need-help-links";

export default function MemberSettingsPage() {
  const { member, refreshProfile } = useMemberArea();
  const [name, setName] = useState(member?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    setName(member?.name ?? "");
  }, [member?.name]);

  async function onSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSavingName(true);
    const { error } = await memberAuth.updateProfile({ name: name.trim() });
    setSavingName(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Profile updated.");
    await refreshProfile();
  }

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await memberAuth.changePassword({ currentPassword, newPassword });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Password changed. You've been signed out of your other sessions.");
    setCurrentPassword("");
    setNewPassword("");
  }

  async function onSignOut() {
    setSigningOut(true);
    await memberAuth.signOut();
    location.href = "/login";
  }

  return (
    <Stack gap={8}>
      <MemberPageHeader title="Settings" description="Password, appearance, and account access." />

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
                <Input id="email" type="email" value={member?.email ?? ""} disabled />
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
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Changing your password signs you out of every other session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
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
            <Button type="submit" disabled={saving}>
              {saving ? "Changing…" : "Change password"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how the member area looks.</CardDescription>
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
          <CardDescription>Need help?</CardDescription>
        </CardHeader>
        <CardContent>
          <NeedHelpLinks />
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={onSignOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </CardFooter>
      </Card>
    </Stack>
  );
}
