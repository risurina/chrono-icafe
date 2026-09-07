"use client";

/**
 * Member "Profile" page — a richer Player Profile dashboard, restyled from the
 * oikos reference into this app's own design system.
 *
 * Layout/copy reference (structure only, not ported — this repo's "improve,
 * don't port oikos" rule): the oikos reference's
 * `~/karta/karta-tenant/apps/chrono-web/src/app/member/profile/page.tsx`, its
 * `isTenant === true` branch (hero + info grid + edit form + membership
 * details + quick actions + branch help). Its raw `div`/`Box`/`Flex` chrome
 * and hardcoded `gold`/`zinc-950`/`white/5` classes are rebuilt here from
 * `agora/ui` primitives, this app's semantic tokens, and the `.premium-*`
 * utilities in `app/globals.css` (sourced from the same oikos palette, so the
 * gold accent/glow reads the same) — the same conversion technique already
 * used by `(apex-marketing)/support/page.tsx` and
 * `(apex-marketing)/company/contact/page.tsx`.
 *
 * Deliberate content differences from the reference, per the accepted scope
 * for this rebuild:
 * - Member Code: sourced from `profile.memberCode` (added by the
 *   `member-code` plan — `ChronoMemberProfiles.memberCode`, generated once
 *   on staff approval). Shown prominently in the hero for an approved
 *   member; "Not assigned" for pending/rejected/never-applied — never a
 *   fabricated value.
 * - hasPassword / "set a password" branch (member-set-password plan): a
 *   member with `hasPassword === false` (social-sign-in-only, no password
 *   credential yet) sees "Set a password" and a single new-password field —
 *   no "current password" field, since there's nothing to verify against —
 *   calling `memberAuth.setPassword()`. Every other member sees today's
 *   "Change password" form calling `memberAuth.changePassword()` unchanged.
 * - No phone field: oikos's tenant profile form has none either. The
 *   previous version of this page had a phone input plus lazy
 *   apply-on-first-save logic (`applyForMembership`/`updateMyProfile`); the
 *   input is removed for fidelity to oikos's two-field form, but the
 *   lazy-create-on-first-save behavior is preserved (see `onSubmit` below) so
 *   a member who hasn't applied yet still gets a `ChronoMemberProfile` row
 *   created on their first save.
 * - Quick Actions link to real routes in this app (`/member/reservations`,
 *   `/member/promos`, `/member/wallet`) instead of oikos's marketing anchors
 *   (`/#rates`, `/#availability`, `/#location`) — this app's tenant landing
 *   page (`(saas-landing)/page.tsx`'s tenant branch) is registry-driven with
 *   no fixed section ids, so those anchors don't resolve here. "Find Branch"
 *   has no equivalent page and is dropped rather than linked to a 404.
 * - The "message the branch" CTA links to `/member/inquiries` (this app's
 *   real staff-facing inquiry queue) instead of a marketing anchor.
 * - The hero's "Approved Member" badge only renders for an actually-approved
 *   member; pending/rejected render their own honest state instead of always
 *   claiming "Approved" the way the reference unconditionally does.
 *
 * Tenant name resolution: `member/layout.tsx` already resolves the tenant's
 * public/display name server-side (`branding?.displayName?.trim() ||
 * tenant.name`, via `/public/branding` + `/public/tenant`) but only passes it
 * down to the page chrome (`MemberGate` → `MemberHeader`), not to
 * `useMemberArea()` or any other context a leaf page can read. Since this
 * page must stay a client component (matching every other `/member/*` page),
 * it reuses that exact same approach — same two endpoints, same precedence —
 * fetched client-side via `agora/client`'s `tenantFetch()` instead of
 * duplicating the server-only host-header logic.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { User, KeyRound, ShieldCheck, MapPin, Clock } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Badge,
  Button,
  Input,
  Label,
  Stack,
  Row,
  Grid,
  buttonVariants,
  toast,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { tenantFetch } from "agora/client";
import { memberAuth } from "@/lib/member-client";
import { useMemberArea } from "@/components/member/member-area-context";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { formatDate } from "@/lib/member/format";
import { applyForMembership } from "@/lib/member/account";
import { getMyLoyalty } from "@/lib/member/loyalty";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type ApplicationStatus = "pending" | "approved" | "rejected";

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  approved: "Approved",
  pending: "Pending review",
  rejected: "Not approved",
};

const STATUS_BADGE_VARIANT: Record<ApplicationStatus, "success" | "secondary" | "outline"> = {
  approved: "success",
  pending: "secondary",
  rejected: "outline",
};

const STATUS_CAPTION: Record<ApplicationStatus, string> = {
  approved: "Your membership is active.",
  pending: "Your application is pending approval.",
  rejected: "Your application was not approved.",
};

const QUICK_ACTIONS = [
  {
    href: "/member/reservations",
    title: "Reservations",
    description: "Check live station availability and book ahead.",
  },
  {
    href: "/member/promos",
    title: "Rates & credit packs",
    description: "See current gaming rates and top-up packs.",
  },
  {
    href: "/member/wallet",
    title: "Wallet",
    description: "View your balance and top-up history.",
  },
] as const;

function InfoTile({
  icon: Icon,
  label,
  value,
  caption,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <Card className="rounded-2xl border-border/60 bg-card/60 backdrop-blur-sm">
      <CardContent className="p-6">
        <Row items="center" gap={2} className="mb-3">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-semibold">{label}</span>
        </Row>
        <p className="truncate text-lg font-medium" title={value}>
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
      </CardContent>
    </Card>
  );
}

export default function MemberProfilePage() {
  const { member, profile, onboarding, approved, refreshProfile } = useMemberArea();
  const [name, setName] = useState(member?.name ?? "");
  const [branchName, setBranchName] = useState("");
  const [memberSince, setMemberSince] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const status: ApplicationStatus = onboarding?.applicationStatus ?? "pending";
  // Undefined only while the session is still loading — default to `true` so
  // the always-safe "Change password" form is what briefly flashes, never
  // the more permissive "Set a password" one.
  const hasPassword = member?.hasPassword ?? true;

  useEffect(() => {
    setName(member?.name ?? "");
  }, [member?.name]);

  useEffect(() => {
    void getMyLoyalty().then((res) => {
      if (res.data) setMemberSince(res.data.memberSince);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetcher = tenantFetch();

    async function loadTenantName() {
      try {
        const [tenantRes, brandingRes] = await Promise.all([
          fetcher(`${API_URL}/public/tenant`),
          fetcher(`${API_URL}/public/branding`),
        ]);
        const tenantJson = tenantRes.ok
          ? ((await tenantRes.json()) as { tenant?: { name: string } | null })
          : null;
        const brandingJson = brandingRes.ok
          ? ((await brandingRes.json()) as { branding?: { displayName: string | null } | null })
          : null;
        const resolved = brandingJson?.branding?.displayName?.trim() || tenantJson?.tenant?.name || "";
        if (!cancelled) setBranchName(resolved);
      } catch {
        // Cosmetic only (the tenant's name is already shown in the page
        // header above this content) — a failed fetch just leaves the "—"
        // fallback in place below.
      }
    }

    void loadTenantName();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    let nameChanged = false;
    if (name.trim() && name.trim() !== member?.name) {
      const { error } = await memberAuth.updateProfile({ name: name.trim() });
      if (error) {
        toast.error(error);
        setSaving(false);
        return;
      }
      nameChanged = true;
    }

    // The chrono membership profile row (`chronoMemberProfile`) is created on
    // first "apply" — `applyForMembership()` is idempotent (returns the
    // existing row unchanged), so a member with no profile yet gets one
    // lazily created here, on their first save, with no phone to carry.
    if (!profile) {
      const { error } = await applyForMembership(undefined);
      if (error) {
        toast.error(error);
        setSaving(false);
        return;
      }
    }

    if (isChangingPassword) {
      const { error } = hasPassword
        ? await memberAuth.changePassword({ currentPassword, newPassword })
        : await memberAuth.setPassword({ newPassword });
      if (error) {
        toast.error(error);
        setSaving(false);
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

    toast.success("Profile updated.");
    await refreshProfile();
    // Refresh the one-shot member session so the header's displayed name
    // picks up a changed name too (mirrors ApplyForTenantPrompt's own
    // reload-after-mutation precedent).
    if (nameChanged) {
      location.reload();
      return;
    }
    setSaving(false);
  }

  return (
    <Stack gap={8}>
      <MemberPageHeader title="Profile" description="Your account and membership details." />

      {/* Hero */}
      <Card className="premium-card-shadow relative overflow-hidden rounded-3xl">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
        />
        <CardHeader className="p-8 md:p-10">
          <Row items="center" gap={3}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <User className="h-5 w-5 text-primary" aria-hidden />
            </span>
            <Stack gap={0}>
              <CardTitle className="premium-text-gradient text-2xl font-black tracking-tight">
                Player Profile
              </CardTitle>
              <CardDescription>Your membership at {branchName || "this venue"}.</CardDescription>
            </Stack>
          </Row>
        </CardHeader>
        <CardContent className="p-8 pt-0 md:p-10 md:pt-0">
          <Row items="center" gap={4} className="flex-wrap">
            <Badge variant={STATUS_BADGE_VARIANT[status]} className="gap-1.5 py-1.5 text-xs font-bold uppercase tracking-wider">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              {status === "approved"
                ? "Approved Member"
                : status === "rejected"
                  ? "Application not approved"
                  : "Application pending"}
            </Badge>
            {approved ? (
              <Stack gap={0} data-testid="member-code">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Member Code</span>
                <span className="premium-text-gradient text-2xl font-black tracking-[0.2em]">
                  {profile?.memberCode ?? "Not assigned"}
                </span>
              </Stack>
            ) : null}
          </Row>
        </CardContent>
      </Card>

      {/* Info grid */}
      <Grid cols={2} gap={4} className="gap-6 lg:grid-cols-4">
        <InfoTile icon={ShieldCheck} label="Status" value={STATUS_LABEL[status]} caption={STATUS_CAPTION[status]} />
        <InfoTile icon={MapPin} label="Branch" value={branchName || "—"} caption="Your primary lounge location." />
        <InfoTile
          icon={Clock}
          label="Member Since"
          value={approved && memberSince ? formatDate(memberSince) : "—"}
          caption="When you were approved."
        />
        <InfoTile icon={User} label="Account" value={member?.email ?? ""} caption="Your logged-in account." />
      </Grid>

      <Grid cols={3} gap={4} className="gap-6">
        {/* Edit Profile Details */}
        <Card className="rounded-2xl sm:col-span-3 lg:col-span-2">
          <form onSubmit={onSubmit}>
            <CardHeader className="p-6">
              <CardTitle>Edit Profile Details</CardTitle>
              <CardDescription>Update your name, and change your password if needed.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <Stack gap={6}>
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

                <div className="space-y-4 border-t border-border pt-4">
                  <Row items="center" className="justify-between">
                    <Row items="center" gap={2}>
                      <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                      <span className="text-sm font-semibold">Security &amp; Password</span>
                    </Row>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => setIsChangingPassword((v) => !v)}
                    >
                      {isChangingPassword ? "Cancel" : hasPassword ? "Change password" : "Set a password"}
                    </Button>
                  </Row>

                  {isChangingPassword ? (
                    <div className="grid grid-cols-2 gap-4">
                      {hasPassword ? (
                        <div className="col-span-2 space-y-2">
                          <Label htmlFor="currentPassword">Current Password</Label>
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
                        <Label htmlFor="newPassword">New Password</Label>
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
                  ) : null}
                </div>
              </Stack>
            </CardContent>
            <CardFooter className="p-6 pt-0">
              <Button type="submit" disabled={saving} className="rounded-full">
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Right column: membership details, quick actions, branch help */}
        <Stack gap={6} className="sm:col-span-3 lg:col-span-1">
          <Card className="rounded-2xl" data-testid="membership-details-card">
            <CardHeader className="p-6">
              <CardTitle>Membership Details</CardTitle>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <Stack gap={3}>
                <Row items="center" className="justify-between border-b border-border pb-3">
                  <span className="text-sm text-muted-foreground">Status</span>
                  <Badge variant={STATUS_BADGE_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
                </Row>
                <Row items="center" className="justify-between border-b border-border pb-3">
                  <span className="text-sm text-muted-foreground">Branch</span>
                  <span className="text-sm font-medium">{branchName || "—"}</span>
                </Row>
                <Row items="center" className="justify-between border-b border-border pb-3">
                  <span className="text-sm text-muted-foreground">Applied On</span>
                  <span className="text-sm font-medium">
                    {onboarding?.appliedAt ? formatDate(onboarding.appliedAt) : "—"}
                  </span>
                </Row>
                <Row items="center" className="justify-between">
                  <span className="text-sm text-muted-foreground">Approved On</span>
                  <span className="text-sm font-medium">
                    {onboarding?.approvedAt ? formatDate(onboarding.approvedAt) : "—"}
                  </span>
                </Row>
              </Stack>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader className="p-6">
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <Stack gap={3}>
                {QUICK_ACTIONS.map((action) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className={cn(
                      buttonVariants({ variant: "outline" }),
                      "h-auto w-full flex-col items-start gap-0.5 whitespace-normal rounded-2xl py-3 text-left",
                    )}
                  >
                    <span className="font-semibold">{action.title}</span>
                    <span className="text-xs font-normal text-muted-foreground">{action.description}</span>
                  </Link>
                ))}
              </Stack>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader className="p-6">
              <CardTitle>Need something changed?</CardTitle>
              <CardDescription>
                If your profile information looks incorrect, message the branch and staff will help sort it
                out.
              </CardDescription>
            </CardHeader>
            <CardFooter className="p-6 pt-0">
              <Link
                href="/member/inquiries"
                className={cn(buttonVariants(), "premium-gradient w-full rounded-2xl border-0")}
              >
                Message the branch
              </Link>
            </CardFooter>
          </Card>
        </Stack>
      </Grid>
    </Stack>
  );
}
