import Link from "next/link";
import { Globe, Mail, MapPin, Phone } from "lucide-react";
import {
  SiteHeader,
  SiteFooter,
  ThemeToggle,
  Stack,
  Row,
  buttonVariants,
  type FooterColumn,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { ChronoBrand } from "./chrono-brand";

/**
 * Chrono's marketing header and footer, matching the karta-oikos/chrono design.
 *
 * One header and one footer, composed from the foundation primitives — the
 * reference ships three near-identical copies of each with no shared code, and
 * the tenant variants below take props rather than duplicating the markup.
 */

const NAV = [
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/#pricing" },
  { label: "About", href: "/about" },
  { label: "Support", href: "/contact" },
  { label: "Login", href: "/login" },
];

/**
 * The header is `fixed` (80px tall), not sticky, so the hero's background
 * bleeds up behind the transparent bar instead of stopping below it. The
 * trade-off: the first section must add its own ~80px of top padding to its
 * *content* so nothing renders under the header.
 */
export function MarketingHeader() {
  return (
    <SiteHeader
      maxWidth="full"
      position="fixed"
      // Transparent over the hero, solidifying once scrolled — the behaviour
      // the reference implements by hand in three separate components.
      transparentUntilScroll
      // h-12 mark + py-4 = the reference's 80px bar.
      containerClassName="h-20"
      navClassName="gap-8"
      brand={
        <Link href="/" aria-label="Chrono home">
          <ChronoBrand />
        </Link>
      }
      nav={NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="font-medium transition-colors hover:text-foreground"
        >
          {item.label}
        </Link>
      ))}
      mobileNav={
        <>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="px-2 py-2">
              {item.label}
            </Link>
          ))}
        </>
      }
      actions={
        <>
          <ThemeToggle />
          <Link
            href="/contact"
            className={cn(
              buttonVariants(),
              // Semantic `bg-primary` + a primary-tinted glow, rather than the
              // reference's hardcoded `bg-gold` / `shadow-gold/20` literals.
              "h-10 rounded-full px-6 text-[10px] font-bold uppercase tracking-widest shadow-lg shadow-primary/20",
            )}
            data-testid="marketing-cta"
          >
            Request Private Demo
          </Link>
        </>
      }
    />
  );
}

/** The reference's footer typography: tiny gold headings, bold caps links. */
const FOOTER_HEADING =
  "text-[10px] font-black uppercase tracking-[0.4em] text-primary";
const FOOTER_LINK =
  "text-sm font-bold uppercase tracking-widest text-muted-foreground hover:text-primary";

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    heading: "Platform",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Private Demo", href: "/contact" },
      { label: "Pricing", href: "/#pricing" },
      { label: "Information", href: "/#faq" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Contact", href: "/contact" },
    ],
  },
];

const SOCIAL_LINKS = [
  { href: "/contact", label: "Email Chrono", Icon: Mail },
  { href: "/contact", label: "Call Chrono", Icon: Phone },
  { href: "/about", label: "About Chrono", Icon: Globe },
];

export function MarketingFooter({ year }: { year: number }) {
  return (
    <SiteFooter
      maxWidth="full"
      // The brand blurb sits *beside* the link columns, as the reference's
      // four-column grid does, rather than on its own row underneath.
      layout="brand-column"
      // `premium-dots` is a background utility, so it can sit straight on the
      // footer element — no absolutely-positioned overlay child needed.
      className="premium-dots relative overflow-hidden pt-12"
      headingClassName={FOOTER_HEADING}
      linkClassName={FOOTER_LINK}
      columns={[
        ...FOOTER_COLUMNS,
        {
          heading: "Location",
          content: (
            <Stack gap={4}>
              <Row gap={3} className="items-start">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="text-sm font-bold tracking-tight text-muted-foreground">
                  City Of SJDM, Bulacan
                  <br />
                  Philippines
                </span>
              </Row>
              <Row gap={3} items="center">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"
                />
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">
                  Operations Live
                </span>
              </Row>
            </Stack>
          ),
        },
      ]}
      brand={
        <Stack gap={6}>
          {/* Flat primary, not the gradient — matches the reference footer. */}
          <ChronoBrand gradient={false} />
          <span className="max-w-sm text-sm font-medium leading-relaxed text-muted-foreground">
            Business management for gaming centers and internet cafes — sessions,
            wallets, shifts and branch operations in one place.
          </span>
          <Row gap={4}>
            {SOCIAL_LINKS.map(({ href, label, Icon }) => (
              <Link
                key={label}
                href={href}
                aria-label={label}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted/30 text-primary/60 transition-all hover:bg-muted/60 hover:text-primary"
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </Link>
            ))}
          </Row>
        </Stack>
      }
      bottomBar={
        <Row className="flex-col items-center justify-between gap-6 text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40 md:flex-row">
          <span>© {year} Chrono. All rights reserved.</span>
          <Row gap={0} className="gap-8">
            <span>Designed in PH</span>
            <span>Powered by Chrono</span>
          </Row>
        </Row>
      }
    />
  );
}

/**
 * The tenant-branded footer variant. Same component, different props — the
 * reference copies 154 lines to achieve this.
 */
export function TenantFooter({
  year,
  tenantName,
  tagline,
  hidePlatformBranding = false,
  platformBrandingLabel = "Powered by Chrono",
}: {
  year: number;
  tenantName: string;
  tagline?: string | null;
  /** Honoured here — the reference stores this flag and ignores it. */
  hidePlatformBranding?: boolean;
  platformBrandingLabel?: string;
}) {
  return (
    <SiteFooter
      maxWidth="full"
      columns={[
        {
          heading: "Navigation",
          links: [
            { label: "Stations", href: "/stations" },
            { label: "About", href: "/about" },
            { label: "Sign in", href: "/portal/login" },
          ],
        },
        {
          heading: "Company",
          links: [
            { label: "Privacy Policy", href: "/privacy" },
            { label: "Terms of Service", href: "/terms" },
            { label: "Contact", href: "/contact" },
          ],
        },
      ]}
      brand={
        <Stack gap={2}>
          <span className="font-chrono text-lg font-black uppercase tracking-tight text-primary">
            {tenantName}
          </span>
          {tagline ? (
            <span className="max-w-sm text-muted-foreground">{tagline}</span>
          ) : null}
        </Stack>
      }
      bottomBar={
        <Row className="flex-col items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.3em] sm:flex-row">
          <span>
            © {year} {tenantName}
          </span>
          {hidePlatformBranding ? null : <span>{platformBrandingLabel}</span>}
        </Row>
      }
    />
  );
}
