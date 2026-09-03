import Link from "next/link";
import {
  Check,
  Timer,
  MonitorPlay,
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
} from "lucide-react";
import {
  cn,
  buttonVariants,
  BrandHeader,
  SiteHeader,
  SiteFooter,
  ThemeToggle,
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
  CardContent,
  CardFooter,
  Badge,
  FaqItem,
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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function fetchTenant(): Promise<{ name: string; slug: string } | null> {
  const t = await getRequestTenant();
  if (t.kind === "apex") return null;
  const headers: Record<string, string> = {};
  if (t.slug) headers["x-tenant-slug"] = t.slug;
  else if (t.host) headers["x-tenant-host"] = t.host;
  try {
    const res = await fetch(`${API_URL}/public/tenant`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()).tenant;
  } catch {
    return null;
  }
}

export default async function Home() {
  const tenant = await fetchTenant();
  const branding = await getPublicBranding();
  const currentYear = new Date().getFullYear();

  // Apex → generic marketing page.
  if (!tenant) {
    const stats = [
      { label: "Branches per business", value: "Unlimited" },
      { label: "Live availability", value: "Public page" },
      { label: "Payment types", value: "Wallet & Cash" },
      { label: "Isolation model", value: "Tenant RLS" },
    ];

    const stations = [
      { name: "Station 01", state: "active" as const, note: "42m left" },
      { name: "Station 02", state: "ready" as const, note: "Available" },
      { name: "Station 03", state: "alert" as const, note: "Awaiting payment" },
    ];

    const activity = [
      "Payment confirmed — Station 03",
      "Shift opened — front desk",
      "Reservation checked in — Station 07",
    ];

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
        label: "Data isolation model",
        legacy: "Shared local files, no real boundary",
        chrono: "Per-tenant row-level security enforced at the database",
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

    return (
      <PageShell data-density="comfortable">
        <SiteHeader
          maxWidth="full"
          brand={
            <>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Timer className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span>Chrono</span>
            </>
          }
          nav={
            <>
              <a href="#features" className="hover:text-foreground">
                Features
              </a>
              <a href="#pricing" className="hover:text-foreground">
                Pricing
              </a>
            </>
          }
          actions={
            <>
              <ThemeToggle />
              <Link href="/login" className={buttonVariants({ variant: "ghost" })}>
                Sign in
              </Link>
              <Link
                href="/sign-up"
                className={cn(buttonVariants(), "rounded-full px-5")}
              >
                Get started
              </Link>
            </>
          }
        />

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
            <div className="py-20 lg:py-28">
              <Grid cols={2} gap={4} className="items-center">
                <Stack gap={6}>
                  <Badge variant="secondary" className="w-fit uppercase tracking-widest">
                    Chrono · Venue management platform
                  </Badge>
                  <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                    One dashboard for every branch, every session, every shift.
                  </h1>
                  <p className="max-w-xl text-balance text-lg text-muted-foreground">
                    Chrono gives multi-branch venue operators real-time visibility into
                    stations, wallets, staff shifts, and reservations — so nothing gets
                    tracked on a whiteboard again.
                  </p>
                  <Row wrap gap={3} className="pt-2">
                    <Link
                      href="/sign-up"
                      className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
                    >
                      Create a business
                    </Link>
                    <Link
                      href="/contact"
                      className={cn(
                        buttonVariants({ variant: "outline", size: "lg" }),
                        "rounded-full px-6",
                      )}
                    >
                      Talk to us
                    </Link>
                  </Row>
                  <Row wrap gap={3} className="w-full max-w-2xl pt-4">
                    {stats.map(({ label, value }) => (
                      <StatTile key={label} label={label} value={value} />
                    ))}
                  </Row>
                </Stack>

                <Card className="overflow-hidden">
                  <CardHeader className="border-b">
                    <Row items="center" justify="between">
                      <Row items="center" gap={2}>
                        <span
                          className="h-2 w-2 rounded-full bg-primary animate-pulse"
                          aria-hidden
                        />
                        <CardTitle className="text-sm">Live Branch Command Center</CardTitle>
                      </Row>
                      <Badge variant="secondary">Example: Main Branch</Badge>
                    </Row>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-4">
                    <Grid cols={4} gap={3}>
                      <StatTile label="Active Sessions" value={18} />
                      <StatTile label="Available Stations" value={7} />
                      <StatTile label="Payments Today" value={24} />
                      <StatTile
                        label="Open Alerts"
                        value={<span className="text-destructive">3</span>}
                        className="border-destructive/30"
                      />
                    </Grid>
                    <Grid cols={2} gap={4}>
                      <Stack gap={2}>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Stations
                        </p>
                        {stations.map((station) => (
                          <Row key={station.name} items="center" justify="between">
                            <Row items="center" gap={2}>
                              <Monitor
                                className={cn(
                                  "h-4 w-4",
                                  station.state === "active" && "text-primary",
                                  station.state === "ready" && "text-muted-foreground",
                                  station.state === "alert" && "text-destructive",
                                )}
                                aria-hidden
                              />
                              <span className="text-sm">{station.name}</span>
                            </Row>
                            <Badge
                              variant={
                                station.state === "active"
                                  ? "default"
                                  : station.state === "alert"
                                    ? "destructive"
                                    : "outline"
                              }
                            >
                              {station.note}
                            </Badge>
                          </Row>
                        ))}
                      </Stack>
                      <Stack gap={2}>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Activity
                        </p>
                        {activity.map((item) => (
                          <p key={item} className="text-sm text-muted-foreground">
                            {item}
                          </p>
                        ))}
                      </Stack>
                    </Grid>
                  </CardContent>
                </Card>
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

          <Section maxWidth="full" border="bottom" tone="muted">
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
              <SectionHeading eyebrow="FAQ" title="Common questions." className="mb-8 max-w-prose" />
              <div className="max-w-3xl">
                {faqs.map(({ q, a }) => (
                  <FaqItem key={q} question={q}>
                    {a}
                  </FaqItem>
                ))}
              </div>
            </div>
          </Section>

          <Section maxWidth="full">
            <Stack gap={4} className="items-center py-24 text-center">
              <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                Ready to run your business on one dashboard?
              </h2>
              <p className="max-w-prose text-balance text-muted-foreground">
                Create your business in seconds — set up branches and stations, invite
                your staff, and open the floor.
              </p>
              <Link
                href="/sign-up"
                className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
              >
                Create a business
              </Link>
            </Stack>
          </Section>
        </Main>

        <SiteFooter
          maxWidth="full"
          brand={<span>© {currentYear} Chrono. All rights reserved.</span>}
          links={
            <>
              <Link href="/login" className="hover:text-foreground">
                Sign in
              </Link>
              <Link href="/sign-up" className="hover:text-foreground">
                Sign up
              </Link>
            </>
          }
        />
      </PageShell>
    );
  }

  // Tenant host → branded mini-landing with both login paths.
  const heading = branding?.displayName?.trim() || tenant.name;

  const tenantHighlights = [
    {
      icon: MonitorPlay,
      title: "Live seat availability",
      description: "Check the floor map and see which stations are currently open.",
    },
    {
      icon: Wallet,
      title: "Your wallet & session history",
      description: "View your current balance, top up, and review past visits.",
    },
    {
      icon: CalendarClock,
      title: "Book ahead",
      description: "Reserve a station or private room for your next visit.",
    },
  ];

  return (
    <PageShell>
      <SiteHeader
        maxWidth="full"
        brand={
          <BrandHeader
            compact
            displayName={branding?.displayName}
            logoUrl={branding?.logoUrl}
            logoDarkUrl={branding?.logoDarkUrl}
            fallback={tenant.name}
          />
        }
        actions={
          <>
            <ThemeToggle />
            <Link href="/portal/login" className={buttonVariants({ variant: "ghost" })}>
              Sign in
            </Link>
            <Link href="/login" className={buttonVariants({ variant: "outline" })}>
              Staff sign in
            </Link>
          </>
        }
      />

      <Main>
        <Section maxWidth="full" border="bottom" className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(circle at top, color-mix(in oklch, var(--color-primary) 12%, transparent), transparent 60%)",
            }}
          />
          <Stack gap={6} className="items-center py-24 text-center">
            {branding?.tagline ? (
              <Badge variant="secondary" className="max-w-sm text-balance uppercase tracking-widest">
                {branding.tagline}
              </Badge>
            ) : null}
            <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
              Welcome to <span className="text-primary">{heading}</span>
            </h1>
            <p className="max-w-xl text-balance text-muted-foreground sm:text-lg">
              View live stations, check your wallet balance, and book your next session.
            </p>
            <Row wrap justify="center" gap={3} className="pt-2">
              <Link
                href="/stations"
                className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
              >
                See live stations
              </Link>
              <Link
                href="/portal/login"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "rounded-full px-6",
                )}
              >
                Sign in
              </Link>
              <Link
                href="/portal/sign-up"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "lg" }),
                  "rounded-full px-6",
                )}
              >
                Create account
              </Link>
            </Row>
          </Stack>
        </Section>

        <Section maxWidth="full" border="bottom" tone="muted">
          <div className="py-16">
            <Grid cols={3} gap={4}>
              {tenantHighlights.map(({ icon: Icon, title, description }) => (
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

        <Section maxWidth="full">
          <div className="py-16">
            <Stack gap={2} className="mb-8 items-center text-center">
              <h2 className="text-heading-md font-semibold tracking-tight">
                Choose how you&apos;d like to sign in
              </h2>
            </Stack>
            <Grid cols={3} gap={4} className="mx-auto max-w-3xl">
              <Card>
                <CardHeader>
                  <CardTitle>Customers</CardTitle>
                  <CardDescription>Access your member area.</CardDescription>
                </CardHeader>
                <CardFooter>
                  <Row wrap>
                    <Link href="/portal/login" className={buttonVariants()}>
                      Sign in
                    </Link>
                    <Link
                      href="/portal/sign-up"
                      className={buttonVariants({ variant: "outline" })}
                    >
                      Create account
                    </Link>
                  </Row>
                </CardFooter>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Staff</CardTitle>
                  <CardDescription>Back-office dashboard.</CardDescription>
                </CardHeader>
                <CardFooter>
                  <Link
                    href="/login"
                    className={buttonVariants({ variant: "secondary" })}
                  >
                    Staff sign in
                  </Link>
                </CardFooter>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>About this business</CardTitle>
                  <CardDescription>Details about this business.</CardDescription>
                </CardHeader>
                <CardFooter>
                  <Link
                    href="/about"
                    className={buttonVariants({ variant: "secondary" })}
                  >
                    View about page
                  </Link>
                </CardFooter>
              </Card>
            </Grid>
          </div>
        </Section>
      </Main>

      <SiteFooter maxWidth="full" brand={<span>© {currentYear} {heading}</span>} />
    </PageShell>
  );
}
