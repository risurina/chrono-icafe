"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useMemberSession, type MemberUser } from "@/lib/member-client";
import { getMyMembership, getMyOnboarding, type MemberOnboarding, type MemberProfile } from "@/lib/member/account";

type MemberAreaValue = {
  member: MemberUser | null;
  profile: MemberProfile | null;
  onboarding: MemberOnboarding | null;
  /** Only Promos/Leaderboard are gated on this — see the plan's decision. */
  approved: boolean;
  loaded: boolean;
  refreshProfile: () => Promise<void>;
};

const MemberAreaContext = createContext<MemberAreaValue | null>(null);

export function useMemberArea(): MemberAreaValue {
  const ctx = useContext(MemberAreaContext);
  if (!ctx) throw new Error("useMemberArea() must be used within <MemberAreaProvider>");
  return ctx;
}

/** Fetches the member's own profile/onboarding once and provides it down the
 * tree — pages read `useMemberArea()` instead of each re-fetching `/me`.
 * `member: null` is the guest-mode case (a signed-in global customer with no
 * `tenantMember` row yet) — both `/me` fetches would 401, so they're skipped
 * entirely and the context resolves immediately to an unlocked/empty state. */
export function MemberAreaProvider({
  member,
  children,
}: {
  member: MemberUser | null;
  children: React.ReactNode;
}) {
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [onboarding, setOnboarding] = useState<MemberOnboarding | null>(null);
  const [loaded, setLoaded] = useState(member === null);

  const refreshProfile = useCallback(async () => {
    if (!member) return;
    const [{ data: p }, { data: o }] = await Promise.all([getMyMembership(), getMyOnboarding()]);
    setProfile(p ?? null);
    setOnboarding(o ?? null);
    setLoaded(true);
  }, [member]);

  useEffect(() => {
    void refreshProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);

  const approved = onboarding?.applicationStatus === "approved";

  return (
    <MemberAreaContext.Provider value={{ member, profile, onboarding, approved, loaded, refreshProfile }}>
      {children}
    </MemberAreaContext.Provider>
  );
}

export { useMemberSession };
