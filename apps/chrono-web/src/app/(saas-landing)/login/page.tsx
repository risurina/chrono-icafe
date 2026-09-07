"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { StaffLoginForm } from "@/components/staff-login-form";
import { MemberLoginForm } from "@/components/member-login-form";

/**
 * `/login` branches on host — the same "renders everywhere, branches
 * internally" pattern the rest of the app uses instead of middleware:
 *
 * - apex: staff sign-in with no tenant context yet (org selection / creation);
 * - tenant host: this business's customer (member) sign-in. Staff sign in at
 *   `/admin/login` on a tenant host instead.
 */
export default function LoginPage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? <MemberLoginForm /> : <StaffLoginForm customerLoginHref="/member/login" />;
}
