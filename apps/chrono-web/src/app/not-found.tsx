import Link from "next/link";
import {
  AuthLayout,
  BrandHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { getPublicBranding } from "@/lib/branding";

/**
 * The global App Router 404 — fired whenever no route matches, or a page
 * calls `notFound()` (e.g. an unresolvable tenant host). Previously there was
 * no `not-found.tsx` anywhere in this app, so an unknown/suspended/deleted
 * tenant subdomain fell through to Next's generic, unbranded default page.
 *
 * `getPublicBranding()` resolves purely from the request host — independent
 * of any landing-page config — so it still renders a tenant's own logo/name
 * when the host belongs to a real, active tenant that simply hit a bad path.
 * For an unknown OR a suspended/terminal-status tenant host, the API's
 * `/public/branding` returns `branding: null` in both cases (`resolveOrgFromRequest`
 * excludes terminal statuses the same way it excludes an unresolvable host) —
 * so this page renders the exact same neutral fallback for both, and never
 * becomes a subdomain-enumeration oracle. The copy below is deliberately
 * generic for the same reason: it never says "this business doesn't exist"
 * vs. "this business is suspended".
 */
export default async function NotFound() {
  const branding = await getPublicBranding();

  return (
    <AuthLayout
      brand={
        <BrandHeader
          displayName={branding?.displayName}
          logoUrl={branding?.logoUrl}
          logoDarkUrl={branding?.logoDarkUrl}
          fallback="Chrono"
        />
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
          <CardDescription>
            The page you&apos;re looking for isn&apos;t available.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            The link may be out of date, or this business may not currently be
            reachable at this address.
          </p>
        </CardContent>
        <CardFooter>
          <Link href="/" className={cn(buttonVariants(), "w-full")}>
            Go to homepage
          </Link>
        </CardFooter>
      </Card>
    </AuthLayout>
  );
}
