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
  Badge,
  Stack,
  Row,
  toast,
} from "agora/ui";
import { memberAuth } from "@/lib/member-client";
import { useMemberArea } from "@/components/member/member-area-context";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { formatDate } from "@/lib/member/format";
import { applyForMembership, updateMyProfile } from "@/lib/member/account";
import { getMyLoyalty } from "@/lib/member/loyalty";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  approved: "default",
  pending: "secondary",
  rejected: "outline",
};

export default function MemberProfilePage() {
  const { member, profile, onboarding, refreshProfile } = useMemberArea();
  const [name, setName] = useState(member?.name ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [memberSince, setMemberSince] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(member?.name ?? "");
    setPhone(profile?.phone ?? "");
  }, [member?.name, profile?.phone]);

  useEffect(() => {
    void getMyLoyalty().then((res) => {
      if (res.data) setMemberSince(res.data.memberSince);
    });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    if (name.trim() && name.trim() !== member?.name) {
      const { error } = await memberAuth.updateProfile({ name: name.trim() });
      if (error) {
        toast.error(error);
        setSaving(false);
        return;
      }
    }

    // The chrono membership profile row (`chronoMemberProfile`) is created on
    // first "apply" — `applyForMembership()` is idempotent (returns the
    // existing row unchanged), so it doubles as an upsert for the phone field
    // when this is the member's first save.
    const phoneResult = profile
      ? await updateMyProfile(phone.trim())
      : await applyForMembership(phone.trim() || undefined);
    if (phoneResult.error) {
      toast.error(phoneResult.error);
      setSaving(false);
      return;
    }

    toast.success("Profile updated.");
    await refreshProfile();
    // Refresh the one-shot member session so the header's displayed name
    // picks up a changed name too (mirrors ApplyForTenantPrompt's own
    // reload-after-mutation precedent).
    if (name.trim() !== member?.name) {
      location.reload();
      return;
    }
    setSaving(false);
  }

  return (
    <Stack gap={6}>
      <MemberPageHeader title="Profile" description="Your account and membership details." />

      <Card>
        <form onSubmit={onSubmit}>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Your name and contact number.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={member?.email ?? ""} disabled />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card data-testid="membership-details-card">
        <CardHeader>
          <CardTitle>Membership</CardTitle>
        </CardHeader>
        <CardContent>
          <Stack gap={3}>
            <Row items="center" className="justify-between">
              <span className="text-sm text-muted-foreground">Application status</span>
              <Badge variant={STATUS_VARIANT[onboarding?.applicationStatus ?? "pending"]} className="capitalize">
                {onboarding?.applicationStatus ?? "pending"}
              </Badge>
            </Row>
            <Row items="center" className="justify-between">
              <span className="text-sm text-muted-foreground">Member since</span>
              <span className="font-medium">{memberSince ? formatDate(memberSince) : "—"}</span>
            </Row>
            <Row items="center" className="justify-between">
              <span className="text-sm text-muted-foreground">Member ID</span>
              <span className="font-mono text-xs">{member?.id}</span>
            </Row>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
