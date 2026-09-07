import { GlobalPortalLayout } from "./global-portal-layout";

/**
 * Apex-only: on a tenant host, `next.config.ts` rewrites `/member/*` to the
 * physical `(tenant-member)/player` tree before this ever renders (except
 * the shared `/member/{login,sign-up,forgot,reset,accept-invite}` auth
 * pages, excluded from that rewrite and served from this same tree on
 * either host, whose links are hardcoded in foundation emails). This group
 * otherwise holds only the global-customer apex pages.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <GlobalPortalLayout>{children}</GlobalPortalLayout>;
}
