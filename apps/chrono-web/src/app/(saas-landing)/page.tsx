import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import {
  Check,
  Wallet,
  CalendarClock,
  MapPin,
  Users,
  Crown,
  Settings,
  UserCircle,
  User,
  LayoutDashboard,
  Smartphone,
  AppWindow,
  Monitor,
  History,
  ShieldCheck,
  AlertCircle,
  Sparkles,
  BarChart3,
  Rocket,
  Gamepad2,
  Building2,
  Coffee,
} from "lucide-react";
import {
  cn,
  buttonVariants,
  PageShell,
  Main,
  Section,
  Grid,
  Stack,
  Row,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  Badge,
  StatTile,
  SectionHeading,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "agora/ui";
import { getRequestTenant } from "@/lib/tenant";
import { getPublicBranding } from "@/lib/branding";
import { getTenantLanding } from "@/lib/landing";
import { getTenantStations } from "@/lib/stations";
import { getTenantVenueInfo } from "@/lib/venue";
import { tenantPageMetadata, tenantStructuredData } from "@/lib/seo";
import { getTenantCanonicalUrl } from "@/lib/tenant";
import { LandingSections } from "@/components/landing/render";
import { TrackOnMount } from "@/components/landing/analytics-bindings";
import type { ChronoLandingData } from "@/components/landing/registry";
import {
  MarketingHeader,
  MarketingFooter,
  TenantHeader,
  TenantFooter,
} from "@/components/landing/marketing-chrome";
import { HeroChips } from "@/components/landing/hero-chips";
import { FaqAccordion } from "@/components/landing/faq-accordion";

/**
 * Host-aware metadata.
 *
 * This file serves BOTH the apex marketing page and every tenant's own public
 * landing page, so a static `export const metadata` would stamp Chrono's
 * marketing copy onto every tenant's page too. The apex branch gets its own
 * marketing metadata; a tenant host defers entirely to `tenantPageMetadata`
 * (`@/lib/seo`), which itself opts out (`{}`) on a non-tenant host so the root
 * layout's default still applies there.
 *
 * No `openGraph.images` on the apex branch — the repo has no marketing OG
 * image asset, and pointing at one that doesn't exist is worse than omitting
 * the field.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getRequestTenant();
  if (t.kind !== "apex") return tenantPageMetadata("/");

  const title = "Chrono — Find gaming cafés, or run one";
  const description =
    "Discover gaming cafés and iCafes near you, connect with your favorite spots, and see live station availability. Gaming businesses run stations, sessions, wallets, and branches on Chrono.";

  return {
    title,
    description,
    keywords: [
      "gaming café",
      "gaming cafe",
      "iCafe",
      "internet cafe",
      "gaming lounge",
      "esports venue",
      "discover gaming cafes",
      "gaming business management",
    ],
    openGraph: { title, description, type: "website" },
  };
}

/** The hero capability strip — the reference's five, in its own wording. */
const HERO_CHIPS = [
  "Station Session Control",
  "Wallet & Manual Payments",
  "Staff Shift Logs",
  "Branch Monitoring",
  "Audit Trail Ready",
] as const;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Which branch renders is decided by the HOST alone, never by whether a fetch
  // succeeded. The page used to derive it from a `/public/tenant` fetch that
  // returned `null` for both "no such tenant" AND "the API call failed", so an
  // unresolvable subdomain silently served the generic Chrono marketing page at
  // that tenant's URL — while `/about` correctly 404'd the same case.
  const t = await getRequestTenant();
  const branding = await getPublicBranding();
  const currentYear = new Date().getFullYear();

  // Apex → generic marketing page.
  if (t.kind === "apex") {
    const problems = [
      {
        title: "Manual tracking gets messy",
        description:
          "Paper logs and group chats can't tell you what happened on a station an hour ago.",
      },
      {
        title: "Owners lack branch visibility",
        description:
          "Without a shared dashboard, owners find out about problems from a phone call, not the data.",
      },
      {
        title: "Staff actions need accountability",
        description:
          "Session changes, refunds, and cash movements should always tie back to the shift that made them.",
      },
      {
        title: "Multi-branch data gets tangled",
        description:
          "Separate spreadsheets or disconnected installs per branch make performance impossible to compare.",
      },
    ];

    const highlights = [
      {
        icon: Monitor,
        title: "Station Session Control",
        description:
          "Start, extend, transfer, and end sessions with a live view of every seat across every branch.",
        wide: true,
      },
      {
        icon: Wallet,
        title: "Wallet & Credits",
        description:
          "Customer balances for time, food, and reservations, debited automatically and tied to the shift.",
      },
      {
        icon: History,
        title: "Staff Shifts & Cash Reconciliation",
        description:
          "Open and close shifts, and reconcile the drawer against what was actually recorded.",
      },
      {
        icon: MapPin,
        title: "Branch Monitoring",
        description:
          "Organize stations, sessions, and staff by branch, all from one owner login.",
      },
      {
        icon: CalendarClock,
        title: "Reservations",
        description:
          "Customers book a station or room ahead of time; staff see it on the floor map.",
      },
      {
        icon: ShieldCheck,
        title: "Audit Trail",
        description:
          "Every session, sale, and cash movement is attributed to the shift and staff member who made it.",
      },
    ];

    const comparisonRows = [
      {
        label: "Scope of visibility",
        legacy: "Per-PC, per-desktop only",
        chrono: "Every branch, every station, one dashboard",
      },
      {
        label: "Payment tracking",
        legacy: "Manual notebook or spreadsheet",
        chrono: "Wallet balances debited automatically, tied to the shift",
      },
      {
        label: "Staff accountability",
        legacy: "No record of who did what",
        chrono: "Every session, sale, and cash movement attributed to a shift",
      },
      {
        label: "Multi-branch support",
        legacy: "Separate, disconnected installs",
        chrono: "Unlimited branches under one business, one login",
      },
      {
        label: "Customer self-service",
        legacy: "None — front desk only",
        chrono: "Customer portal for balance, history, and booking",
      },
      {
        // Same fact, said the way an owner reads it. "Per-tenant row-level
        // security enforced at the database" is how the engineers describe it;
        // it is not why a café owner would choose Chrono. The precise wording
        // survives in the FAQ, where someone asking that question wants it.
        label: "Your business's data",
        legacy: "Shared local files, no real boundary",
        chrono: "Walled off from every other business, enforced by the database",
      },
    ];

    const roles = [
      {
        icon: Crown,
        name: "Owner",
        description: "Full visibility across all branches, billing, and global settings.",
      },
      {
        icon: Settings,
        name: "Manager",
        description: "Branch-specific administration, shift overrides, and inventory.",
      },
      {
        icon: User,
        name: "Floor staff",
        description: "POS operations, starting sessions, and handling cash drawers.",
      },
      {
        icon: UserCircle,
        name: "Customer",
        description: "Self-service booking, ordering, and wallet top-ups.",
      },
    ];

    const steps = [
      {
        title: "Create your business",
        description: "Sign up and set your basic branding and billing currency.",
      },
      {
        title: "Add branches & stations",
        description: "Register each location and the stations customers sit at.",
      },
      {
        title: "Open the floor",
        description: "Invite your staff and start checking in customers.",
      },
      {
        title: "Track wallets & shifts",
        description: "Top up member balances and let staff open shifts to start reconciling cash.",
      },
      {
        title: "Review the audit trail",
        description: "See every session, sale, and cash movement tied back to the shift that made it.",
      },
    ];

    const benefits = [
      {
        icon: Sparkles,
        title: "Cleaner floor operations",
        description: "Staff get one screen for sessions, orders, and wallets — less friction, fewer mistakes.",
      },
      {
        icon: BarChart3,
        title: "Full visibility",
        description: "See active stations, wallet activity, and shift cash in real time, from any branch.",
      },
      {
        icon: Users,
        title: "A better customer experience",
        description: "Live station availability and self-service booking, without a phone call.",
      },
      {
        icon: Rocket,
        title: "Built to grow",
        description: "Add a new branch without adding a new spreadsheet.",
      },
    ];

    const pricingTiers = [
      {
        name: "Single Branch",
        description: "For one location getting session tracking and wallets under control.",
        features: ["Station session control", "Wallet & credits", "Staff shifts", "Basic reporting"],
        recommended: false,
      },
      {
        name: "Growing Business",
        description: "For venues opening a second location or adding reservations.",
        features: ["Everything in Single Branch", "Reservations", "Branch monitoring", "Audit trail"],
        recommended: true,
      },
      {
        name: "Multi-Branch",
        description: "For operators running several branches from one account.",
        features: ["Everything in Growing Business", "Cross-branch owner dashboard", "Custom onboarding"],
        recommended: false,
      },
    ];

    const faqs = [
      {
        q: "Does it support multi-branch businesses?",
        a: "Yes. Every business can manage multiple physical locations (branches), with staff scoped to specific branches and customers sharing a single unified wallet across all of them.",
      },
      {
        q: "Can customers see what's free before they arrive?",
        a: "Yes. Every business gets a public live-availability page at its own address, showing station status in real time. No account or app needed to view it.",
      },
      {
        q: "How do wallets and credits work?",
        a: "Each customer holds a balance on your business, topped up at the desk. Sessions and purchases are debited from that balance, and every movement is recorded against the shift that made it.",
      },
      {
        q: "How do staff shifts and cash handling work?",
        a: "Staff open and close shifts, and cash movements are attributed to the shift that handled them, so a close-out can be reconciled against what the drawer actually holds.",
      },
      {
        q: "What do customers get their own access to?",
        a: "A customer portal on your business's address where they sign up, sign in, and see their own balance and history — separate from your staff dashboard.",
      },
      {
        q: "Can I run more than one business from one account?",
        a: "Yes. Each business runs on its own address, with its own staff, customers, and data kept separate from every other business on the platform.",
      },
      {
        q: "Is my data isolated from other businesses on the platform?",
        a: "Yes. Every business's data is isolated with row-level security enforced at the database — not just filtered by the application — so one business can never see another's rows.",
      },
    ];

    // Gaming-only. The previous list (co-working spaces, study cafés) diluted
    // the primary market this page is repositioning around.
    const trustCategories = [
      { icon: Gamepad2, label: "iCafes" },
      { icon: Building2, label: "Gaming Lounges" },
      { icon: Coffee, label: "Esports Venues" },
      { icon: Users, label: "Multi-Branch Chains" },
    ];

    /**
     * Player-facing value. Every entry maps to something that exists today:
     * session history, wallet + top-up, loyalty/credit packs, reservations
     * against live per-branch station status, and the foundation's global
     * customer pool. Deliberately ABSENT: favorites/following and
     * notifications — neither is built, so neither is claimed.
     */
    const playerValue = [
      {
        title: "One account, every business",
        description:
          "Sign up once and use the same account at every gaming business you join on Chrono.",
      },
      {
        title: "See what's free before you go",
        description:
          "Listed businesses publish live station availability, so you know what's open before you travel.",
      },
      {
        title: "Book a station",
        description:
          "Reserve against real per-branch station status instead of hoping something is free.",
      },
      {
        title: "Your wallet and credits",
        description:
          "Check your balance, top up, and buy credit packs without queueing at the counter.",
      },
      {
        title: "Your session history",
        description:
          "Every session you've played, with the time and spend attached — not a paper log.",
      },
      {
        title: "Loyalty that follows you",
        description:
          "Earn and redeem at the businesses you play at, tracked against your own account.",
      },
    ];

    /** The cold-start mechanic, in the order a player actually experiences it. */
    const coldStartLoop = [
      {
        title: "Search for your café",
        description: "Look for the gaming spot you already play at on Chrono's discovery page.",
      },
      {
        title: "Not there? Invite them",
        description:
          "Tell us which business you want to see here. It takes one form and a player account.",
      },
      {
        title: "They join",
        description:
          "When that business signs up, it sees how many players had already asked for it.",
      },
      {
        title: "You connect",
        description:
          "Join them from your existing account — no second signup, no second password.",
      },
    ];

    /**
     * Partner-facing value. Trimmed to the strongest six so the business pitch
     * supports the page rather than dominating it; the full operational depth
     * lives in the sections further down.
     */
    const businessValue = [
      {
        title: "Run your floor live",
        description:
          "Manage gaming stations and sessions as they happen, across every branch.",
      },
      {
        title: "Wallets and payments",
        description:
          "Take counter payments and online top-ups, with the ledger kept straight for you.",
      },
      {
        title: "Staff access that fits your team",
        description:
          "Give each person exactly the access their job needs, using roles you control.",
      },
      {
        title: "Every branch, one account",
        description:
          "Branches carry their own hours, maps, and social links — and roll up to one view.",
      },
      {
        title: "Be discoverable",
        description:
          "Publish your page and players can find you on Chrono's public discovery page.",
      },
      {
        title: "See who's asking for you",
        description:
          "Players can request businesses that aren't here yet. If they asked for you, you'll know.",
      },
    ];

    // "Tenant data isolation → Row-level" is gone: it is developer language, not
    // a reason a player or a café owner picks Chrono. Every remaining stat is a
    // real, checkable capability — nothing here claims network size.
    const trustStats = [
      { label: "Branches per account", value: "Unlimited" },
      { label: "Built-in workflows", value: "20+" },
      { label: "Realtime sync", value: "Built-in" },
      { label: "Live station availability", value: "Public" },
    ];

    return (
      <PageShell data-density="comfortable">
        <MarketingHeader />

        <Main>
          <Section maxWidth="full" border="bottom" className="relative overflow-hidden">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10"
              style={{
                backgroundImage:
                  "radial-gradient(color-mix(in oklch, var(--color-foreground) 14%, transparent) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
                maskImage:
                  "radial-gradient(ellipse 60% 50% at 50% 0%, black 40%, transparent 100%)",
                WebkitMaskImage:
                  "radial-gradient(ellipse 60% 50% at 50% 0%, black 40%, transparent 100%)",
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10"
              style={{
                background:
                  "radial-gradient(circle at top, color-mix(in oklch, var(--color-primary) 10%, transparent), transparent 60%)",
              }}
            />
            {/* pt clears the 80px fixed header; the section background still
                bleeds up behind it, which is the point of the transparent bar. */}
            <div className="pb-20 pt-32 lg:pb-28 lg:pt-40">
              <Grid cols={2} gap={4} className="items-center">
                <Stack gap={6}>
                  <Badge variant="secondary" className="w-fit uppercase tracking-widest">
                    The gaming network
                  </Badge>
                  <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                    Where gamers and gaming businesses connect.
                  </h1>
                  <p className="max-w-xl text-balance text-lg text-muted-foreground">
                    Find gaming cafés, connect with your favorite spots, and discover a
                    better way to game. Business owners can manage their operations and
                    put their venue in front of Chrono players.
                  </p>
                  {/* Two audiences, one row: player primary, partner secondary,
                      discovery tertiary. `id="join"` is the anchor the header CTA
                      targets. */}
                  <Row wrap gap={3} className="pt-2" id="join">
                    <Link
                      href="/portal/sign-up"
                      className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
                    >
                      Join as a Player
                    </Link>
                    <Link
                      href="/sign-up"
                      className={cn(
                        buttonVariants({ variant: "outline", size: "lg" }),
                        "rounded-full px-6",
                      )}
                    >
                      Join as a Partner
                    </Link>
                    <Link
                      href="/discover"
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "lg" }),
                        "rounded-full px-6",
                      )}
                    >
                      Find a Gaming Cafe
                    </Link>
                  </Row>
                  {/* The returning player's way in. `/login` in the nav is the
                      staff/partner entry, so without this the page would offer
                      new players a door and returning ones none. */}
                  <p className="text-sm text-muted-foreground">
                    Already play on Chrono?{" "}
                    <Link href="/portal/login" className="font-medium underline underline-offset-4">
                      Sign in
                    </Link>
                    {" · "}
                    <Link
                      href="/discover?invite=1"
                      className="font-medium underline underline-offset-4"
                    >
                      Can&apos;t find your cafe? Invite them
                    </Link>
                  </p>
                  <HeroChips items={HERO_CHIPS} className="max-w-2xl" />
                  <p className="max-w-xl text-sm text-muted-foreground/70">
                    Free to start — no credit card required.
                  </p>
                </Stack>

                <Row items="center" justify="center" className="h-full">
                  <Image
                    src="/brand/mascot.png"
                    alt="Chrono owl mascot"
                    width={768}
                    height={512}
                    priority
                    className="h-auto w-full max-w-md object-contain"
                  />
                </Row>
              </Grid>
            </div>
          </Section>

          {/* ── For players ─────────────────────────────────────────────
              Every bullet below is a capability that exists today. No
              favorites/following and no notifications: both are confirmed
              absent, and this page does not advertise what it cannot do. */}
          <Section id="for-players" maxWidth="full" border="bottom" className="scroll-mt-16">
            <div className="py-20">
              <SectionHeading
                eyebrow="For players"
                title="Your favorite gaming spots. One place."
                className="mb-12 max-w-prose"
              />
              <Grid cols={3} gap={4}>
                {playerValue.map(({ title, description }) => (
                  <Card key={title}>
                    <CardHeader>
                      <CardTitle className="text-base">{title}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          {/* ── The cold-start loop ─────────────────────────────────────
              Plain primitives, no charting dependency — the same visual
              language as the "How it works" strip below. */}
          <Section maxWidth="full" border="bottom" tone="muted">
            <div className="py-20">
              <SectionHeading
                eyebrow="The loop"
                title="Can't find your café? Bring them here."
                className="mb-12 max-w-prose"
              />
              <Grid cols={4} gap={4}>
                {coldStartLoop.map(({ title, description }, i) => (
                  <Stack key={title} gap={3}>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                      {i + 1}
                    </span>
                    <h3 className="font-semibold">{title}</h3>
                    <p className="text-sm text-muted-foreground">{description}</p>
                  </Stack>
                ))}
              </Grid>
              <Row className="pt-10">
                <Link
                  href="/discover"
                  className={cn(buttonVariants({ variant: "outline" }), "rounded-full px-6")}
                >
                  Start with a search
                </Link>
              </Row>
            </div>
          </Section>

          {/* ── For businesses ──────────────────────────────────────────── */}
          <Section
            id="for-businesses"
            maxWidth="full"
            border="bottom"
            className="scroll-mt-16"
          >
            <div className="py-20">
              <SectionHeading
                eyebrow="For businesses"
                title="Your gaming business should be where your players are."
                className="mb-12 max-w-prose"
              />
              <Grid cols={3} gap={4}>
                {businessValue.map(({ title, description }) => (
                  <Card key={title}>
                    <CardHeader>
                      <CardTitle className="text-base">{title}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          {/* ── Live availability ───────────────────────────────────────
              Demonstrable rather than mocked: the CTA goes to the real
              /discover surface, which reads the same live station counts. */}
          <Section maxWidth="full" border="bottom" tone="muted">
            <div className="py-20">
              <SectionHeading
                eyebrow="Live availability"
                title="Know what's available before you go."
                description="Listed businesses show how many stations are free right now, straight from the floor — not a guess, and not a screenshot."
                className="mb-8 max-w-prose"
              />
              <Row wrap gap={3}>
                <Link
                  href="/discover"
                  className={cn(buttonVariants(), "rounded-full px-6")}
                >
                  Check availability now
                </Link>
              </Row>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <SectionHeading
                eyebrow="By design"
                title="Built for every kind of floor — and the scale to back it up."
                align="center"
                className="mx-auto mb-10 max-w-prose"
              />
              <Row wrap items="center" justify="center" gap={3}>
                {trustCategories.map(({ icon: Icon, label }) => (
                  <Badge
                    key={label}
                    variant="outline"
                    className="gap-2 py-2 px-3 text-sm font-normal text-muted-foreground"
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {label}
                  </Badge>
                ))}
              </Row>
              <Grid cols={2} gap={4} className="mt-10 lg:grid-cols-4">
                {trustStats.map(({ label, value }) => (
                  <StatTile key={label} label={label} value={value} />
                ))}
              </Grid>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <SectionHeading
                eyebrow="Operational reality"
                title="Old tools were built for control. Chrono is built for visibility."
                className="mb-12 max-w-prose"
              />
              <Grid cols={2} gap={4}>
                {problems.map(({ title, description }) => (
                  <Card key={title}>
                    <CardHeader>
                      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
                        <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
                      </div>
                      <CardTitle className="text-base">{title}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          <Section
            id="features"
            maxWidth="full"
            border="bottom"
            tone="muted"
            className="scroll-mt-16"
          >
            <div className="py-20">
              <SectionHeading
                eyebrow="The Chrono way"
                title="Everything your business needs, out of the box."
                description="A unified platform for sessions, payments, staff, and every branch you run."
                className="mb-12 max-w-prose"
              />
              <Grid cols={3} gap={4}>
                {highlights.map(({ icon: Icon, title, description, wide }) => (
                  <Card
                    key={title}
                    className={cn("transition-shadow hover:shadow-md", wide && "md:col-span-2")}
                  >
                    <CardHeader>
                      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" aria-hidden />
                      </div>
                      <CardTitle className="text-base">{title}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <SectionHeading
                eyebrow="Comparison"
                title="A modern alternative to legacy timer software."
                className="mb-12 max-w-prose"
              />
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Capability</TableHead>
                      <TableHead>Legacy timer software</TableHead>
                      <TableHead>Chrono</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comparisonRows.map((row) => (
                      <TableRow key={row.label}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        <TableCell className="text-muted-foreground">{row.legacy}</TableCell>
                        <TableCell>{row.chrono}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom" tone="muted">
            <div className="py-20">
              <SectionHeading
                eyebrow="Roles"
                title="Designed around everyone on your floor."
                description="Four distinct audiences, each with a tailored surface and the exact permissions they need."
                className="mb-12 max-w-prose"
              />
              <Grid cols={4} gap={4}>
                {roles.map(({ icon: Icon, name, description }) => (
                  <Card key={name}>
                    <CardHeader>
                      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" aria-hidden />
                      </div>
                      <CardTitle className="text-base">{name}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <SectionHeading
                eyebrow="Surfaces"
                title="A portal for everyone."
                description="Dedicated interfaces for your staff, your customers, and the public."
                className="mb-12 max-w-prose"
              />
              <Grid cols={3} gap={4}>
                <Card>
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <LayoutDashboard className="h-5 w-5 text-primary" aria-hidden />
                    </div>
                    <CardTitle className="text-base">Staff dashboard</CardTitle>
                    <CardDescription>Back-office tools, POS, and floor maps for operators.</CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Smartphone className="h-5 w-5 text-primary" aria-hidden />
                    </div>
                    <CardTitle className="text-base">Customer portal</CardTitle>
                    <CardDescription>Self-service balance, session history, and reservations.</CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <AppWindow className="h-5 w-5 text-primary" aria-hidden />
                    </div>
                    <CardTitle className="text-base">Live stations</CardTitle>
                    <CardDescription>A public landing page showing live seat availability.</CardDescription>
                  </CardHeader>
                </Card>
              </Grid>
            </div>
          </Section>

          <Section
            id="how-it-works"
            maxWidth="full"
            border="bottom"
            tone="muted"
            className="scroll-mt-16"
          >
            <div className="py-20">
              <SectionHeading
                eyebrow="How it works"
                title="Structured for daily business operations."
                className="mb-12 max-w-prose"
              />
              <Grid cols={4} gap={4}>
                {steps.map(({ title, description }, i) => (
                  <Stack key={title} gap={3}>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-background">
                      {i + 1}
                    </span>
                    <h3 className="font-semibold">{title}</h3>
                    <p className="text-sm text-muted-foreground">{description}</p>
                  </Stack>
                ))}
              </Grid>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <SectionHeading
                eyebrow="Why it's built this way"
                title="Less noise. More control."
                description="Chrono is for owners who want one clear picture of the business, not four disconnected tools."
                align="center"
                className="mx-auto mb-12 max-w-prose items-center text-center"
              />
              <Grid cols={4} gap={4}>
                {benefits.map(({ icon: Icon, title, description }) => (
                  <Card key={title}>
                    <CardHeader>
                      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" aria-hidden />
                      </div>
                      <CardTitle className="text-base">{title}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          <Section id="pricing" maxWidth="full" border="bottom" tone="muted" className="scroll-mt-16">
            <div className="py-20">
              <SectionHeading
                eyebrow="Plans"
                title="Sized to how you run your business."
                description="Every plan includes multi-branch support and tenant-isolated data. Talk to us for a walkthrough mapped to your setup."
                className="mb-12 max-w-prose"
              />
              <Grid cols={3} gap={4}>
                {pricingTiers.map((tier) => (
                  <Card key={tier.name} className={cn(tier.recommended && "border-primary/40")}>
                    <CardHeader>
                      <Row items="center" justify="between">
                        <CardTitle className="text-base">{tier.name}</CardTitle>
                        {tier.recommended ? <Badge>Recommended</Badge> : null}
                      </Row>
                      <CardDescription>{tier.description}</CardDescription>
                    </CardHeader>
                    <CardFooter>
                      <Stack gap={3} className="w-full">
                        <Stack gap={2}>
                          {tier.features.map((feature) => (
                            <Row key={feature} gap={2} items="start">
                              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                              <span className="text-sm">{feature}</span>
                            </Row>
                          ))}
                        </Stack>
                        <Link
                          href="/contact"
                          className={buttonVariants({
                            variant: tier.recommended ? "default" : "outline",
                            className: "w-full",
                          })}
                        >
                          Talk to us
                        </Link>
                      </Stack>
                    </CardFooter>
                  </Card>
                ))}
              </Grid>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <FaqAccordion
                eyebrow="FAQ"
                title="Common questions"
                description="Everything you need to know about running your business on Chrono."
                faqs={faqs}
              />
            </div>
          </Section>

          <Section maxWidth="full">
            <Stack gap={4} className="items-center py-24 text-center">
              <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                Two ways in.
              </h2>
              <p className="max-w-prose text-balance text-muted-foreground">
                Players: find your café and connect to it. Businesses: set up branches
                and stations, invite your staff, and get in front of Chrono players.
              </p>
              <Row wrap gap={3} justify="center">
                <Link
                  href="/portal/sign-up"
                  className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
                >
                  Join Chrono Free
                </Link>
                <Link
                  href="/sign-up"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "rounded-full px-6",
                  )}
                >
                  Become a Chrono Partner
                </Link>
              </Row>
            </Stack>
          </Section>
        </Main>

        <MarketingFooter year={currentYear} />
      </PageShell>
    );
  }

  // Tenant host → the registry-driven public landing page.
  //
  // Which sections render, and in what order, comes from the tenant's published
  // config resolved against `CHRONO_LANDING_SECTIONS` — so re-ordering or
  // hiding one is a settings change, not a code change. This replaces a
  // hardcoded three-card placeholder that never read the tenant's config at all.
  const [landing, stations, venue] = await Promise.all([
    getTenantLanding(),
    getTenantStations(),
    getTenantVenueInfo(),
  ]);

  // Parity with `/about` (`about/page.tsx`): only "no such tenant" is a 404.
  // `getTenantLanding()` degrades a missing/unpublished/unreachable landing
  // config to defaults and returns non-null, so a live tenant still renders
  // through a content blip instead of 404ing.
  if (!landing) notFound();

  // Traffic-source attribution (QR code, global discovery, direct, …) — read
  // once, server-side, and defaulted to "direct" when absent. `TrackOnMount`
  // passes it through `TENANT_PAGE_VIEW`'s own props, and `track()` persists
  // it (`lib/analytics.ts`) so a later conversion event in the same session
  // carries the same value.
  const rawSource = (await searchParams).source;
  const source = (Array.isArray(rawSource) ? rawSource[0] : rawSource) || "direct";

  const heading = branding?.displayName?.trim() || landing.venueName;
  const canonicalUrl = await getTenantCanonicalUrl("/");
  const structuredData = tenantStructuredData(venue, branding, {
    name: heading,
    url: canonicalUrl,
    description: landing.resolved.seo.description ?? landing.resolved.hero.subtitle ?? null,
  });

  return (
    <PageShell>
      {structuredData ? (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- server-rendered, server-controlled JSON-LD, not user HTML.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      ) : null}
      <TenantHeader
        tenantName={heading}
        displayName={branding?.displayName}
        logoUrl={branding?.logoUrl}
        logoDarkUrl={branding?.logoDarkUrl}
      />

      <Main>
        <TrackOnMount
          event="TENANT_PAGE_VIEW"
          props={{ tenantName: heading, path: "/", source }}
        />
        <LandingSections
          surface="tenant"
          sections={landing.sections}
          resolved={landing.resolved}
          context={{
            tenantName: heading,
            tenantSlug: landing.tenantSlug,
            data: { stations, venue } satisfies ChronoLandingData,
          }}
        />
      </Main>

      <TenantFooter
        year={currentYear}
        tenantName={heading}
        tagline={branding?.tagline}
      />
    </PageShell>
  );
}
