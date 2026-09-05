import { GlobalPortalLayout } from "./global-portal-layout";

/**
 * Apex-only now: the tenant member area moved to `/member/*`
 * (`next.config.ts` redirects a tenant host's `/portal` there before this
 * ever renders). This group keeps only the global-customer apex pages plus
 * the shared `/portal/{login,sign-up,forgot,reset,accept-invite}` auth
 * pages, whose links are hardcoded in foundation emails.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <GlobalPortalLayout>{children}</GlobalPortalLayout>;
}
