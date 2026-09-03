"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { TenantSignUpForm } from "./tenant-sign-up-form";
import { GlobalSignUpForm } from "./global-sign-up-form";

export default function PortalSignUpPage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? <TenantSignUpForm /> : <GlobalSignUpForm />;
}
