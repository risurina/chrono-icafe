"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { TenantForgotForm } from "./tenant-forgot-form";
import { GlobalForgotForm } from "./global-forgot-form";

export default function PortalForgotPage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? <TenantForgotForm /> : <GlobalForgotForm />;
}
