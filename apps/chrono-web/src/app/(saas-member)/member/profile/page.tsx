import { GlobalPortalProfile } from "./global-portal-profile";

/** Apex-only — a tenant host's `/member` is rewritten to `(tenant-member)/player` before this renders. */
export default function PortalProfilePage() {
  return <GlobalPortalProfile />;
}
