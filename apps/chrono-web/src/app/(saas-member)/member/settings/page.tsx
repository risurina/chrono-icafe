import { GlobalPortalSettings } from "./global-portal-settings";

/** Apex-only — a tenant host's `/member` is rewritten to `(tenant-member)/player` before this renders. */
export default function PortalSettingsPage() {
  return <GlobalPortalSettings />;
}
