import { api, unwrap, type Result } from "./client";

export type MemberProfile = {
  id: string;
  tenantId: string;
  memberId: string;
  phone: string | null;
  memberCode: string | null;
  applicationStatus: "pending" | "approved" | "rejected";
  appliedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemberOnboarding = {
  applicationStatus: "pending" | "approved" | "rejected";
  appliedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  wallet: { balance: string; currency: string; exists: boolean };
  memberRateEligible: boolean;
};

export function getMyMembership(): Promise<Result<MemberProfile | null>> {
  return api.portal.members.me.$get().then((res) =>
    unwrap(res, (json) => (json as { profile: MemberProfile | null }).profile),
  );
}

export function getMyOnboarding(): Promise<Result<MemberOnboarding>> {
  return api.portal.members.me.onboarding.$get().then((res) =>
    unwrap(res, (json) => json as MemberOnboarding),
  );
}

export function applyForMembership(phone?: string): Promise<Result<MemberProfile | null>> {
  return api.portal.members.apply
    .$post({ json: { phone: phone ?? undefined } })
    .then((res) => unwrap(res, (json) => (json as { profile: MemberProfile | null }).profile));
}

export function updateMyProfile(phone: string): Promise<Result<MemberProfile | null>> {
  return api.portal.members.me
    .$patch({ json: { phone } })
    .then((res) => unwrap(res, (json) => (json as { profile: MemberProfile | null }).profile));
}
