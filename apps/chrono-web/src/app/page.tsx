import Link from "next/link";
import {
  Check,
  X,
  Timer,
  MonitorPlay,
  Wallet,
  CalendarClock,
  MapPin,
  Clock,
  Users,
  Briefcase,
  ShoppingCart,
  Crown,
  Settings,
  UserCircle,
  User,
  LayoutDashboard,
  Smartphone,
  AppWindow,
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
  CardFooter,
  Badge,
  FaqItem,
  StatTile,
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
    const highlights = [
      {
        icon: MapPin,
        title: "Stations & floor map",
        description: "Visual floor plans showing live seat status across all your branches.",
      },
      {
        icon: Clock,
        title: "Timed sessions",
        description: "Pre-paid and post-paid session tracking with automated lock screens.",
      },
      {
        icon: Wallet,
        title: "Wallet & credits",
        description: "Customer balances for time, food, and reservations.",
      },
      {
        icon: Users,
        title: "Members & loyalty",
        description: "Customer tiers, points, and member-only pricing.",
      },
      {
        icon: Briefcase,
        title: "Shifts & staff",
        description: "Time tracking, register cash counts, and permission scoping.",
      },
      {
        icon: ShoppingCart,
        title: "POS & reservations",
        description: "In-seat ordering and advance booking for PCs and console rooms.",
      },
    ];

    const withoutChrono = [
      "Tracking member balances in spreadsheets and a whiteboard",
      "Manual timer alarms when a customer's session expires",
      "No visibility into station availability until they walk in the door",
    ];
    const withChrono = [
      "Unified customer wallets for time, food, and reservations",
      "Automated session enforcement on PC and console endpoints",
      "Real-time floor map for staff and a live public page for customers",
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
        title: "Create your venue",
        description: "Sign up and set your basic branding and billing currency.",
      },
      {
        title: "Add branches & stations",
        description: "Draw your floor plans and set your hourly pricing tiers.",
      },
      {
        title: "Open the floor",
        description: "Invite your staff and start checking in customers.",
      },
    ];

    const stats = [
      { label: "Branches per venue", value: "Unlimited" },
      { label: "Live availability", value: "Public page" },
      { label: "Payment types", value: "Wallet & Cash" },
      { label: "Isolation model", value: "Tenant RLS" },
    ];


    const faqs = [
      {
        q: "Does it support multi-branch venues?",
        a: "Yes. Every venue can manage multiple physical locations (branches), with staff scoped to specific branches and customers sharing a single unified wallet across all of them.",
      },
      {
        q: "Can customers see what's free before they arrive?",
        a: "Yes. Every venue gets a public live-availability page at its own address, showing station status in real time. No account or app needed to view it.",
      },
      {
        q: "How do wallets and credits work?",
        a: "Each customer holds a balance on your venue, topped up at the desk. Sessions and purchases are debited from that balance, and every movement is recorded against the shift that made it.",
      },
      {
        q: "How do staff shifts and cash handling work?",
        a: "Staff open and close shifts, and cash movements are attributed to the shift that handled them, so a close-out can be reconciled against what the drawer actually holds.",
      },
      {
        q: "What do customers get their own access to?",
        a: "A customer portal on your venue's address where they sign up, sign in, and see their own balance and history — separate from your staff dashboard.",
      },
      {
        q: "Can I run more than one venue from one account?",
        a: "Yes. Each venue is its own workspace on its own address, with its own staff, customers, and data kept separate from every other venue on the platform.",
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
            <a href="#features" className="hover:text-foreground">
              Features
            </a>
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
            <Stack gap={6} className="items-center py-28 text-center">
              <Badge variant="secondary" className="uppercase tracking-widest">
                Chrono - Venue management
              </Badge>
              <h1 className="text-balance text-5xl font-bold tracking-tight sm:text-7xl">
                Run your gaming venue on modern software.
              </h1>
              <p className="max-w-2xl text-balance text-lg text-muted-foreground sm:text-xl">
                Manage floor maps, automated timed sessions, member wallets, and staff shifts in one place. Stop fighting legacy desktop software and start running your cafe from the cloud.
              </p>
              <Row wrap justify="center" gap={3} className="pt-2">
                <Link
                  href="/sign-up"
                  className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
                >
                  Create a venue
                </Link>
                <Link
                  href="/login"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "rounded-full px-6",
                  )}
                >
                  Sign in
                </Link>
              </Row>
              <Row wrap justify="center" gap={3} className="w-full max-w-3xl pt-6">
                {stats.map(({ label, value }) => (
                  <StatTile key={label} label={label} value={value} />
                ))}
              </Row>
            </Stack>
          </Section>

          <Section
            id="features"
            maxWidth="full"
            border="bottom"
            tone="muted"
            className="scroll-mt-16"
          >
            <div className="py-20">
              <Stack gap={2} className="mb-12 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Why Chrono
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Everything an internet cafe needs, out of the box.
                </h2>
                <p className="text-muted-foreground">
                  A unified platform for time, payments, and staff.
                </p>
              </Stack>
              <Grid cols={2} gap={4}>
                {highlights.map(({ icon: Icon, title, description }) => (
                  <Card key={title} className="transition-shadow hover:shadow-md">
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
              <Stack gap={2} className="mb-12 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  The old way
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Leave the whiteboard behind.
                </h2>
              </Stack>
              <Grid cols={2} gap={4}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base text-muted-foreground">
                      Without Chrono
                    </CardTitle>
                  </CardHeader>
                  <CardFooter>
                    <Stack gap={3} className="w-full">
                      {withoutChrono.map((item) => (
                        <Row key={item} gap={3} items="start">
                          <X
                            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="text-sm text-muted-foreground">{item}</span>
                        </Row>
                      ))}
                    </Stack>
                  </CardFooter>
                </Card>
                <Card className="border-primary/30">
                  <CardHeader>
                    <CardTitle className="text-base">With Chrono</CardTitle>
                  </CardHeader>
                  <CardFooter>
                    <Stack gap={3} className="w-full">
                      {withChrono.map((item) => (
                        <Row key={item} gap={3} items="start">
                          <Check
                            className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                            aria-hidden
                          />
                          <span className="text-sm">{item}</span>
                        </Row>
                      ))}
                    </Stack>
                  </CardFooter>
                </Card>
              </Grid>
            </div>
          </Section>

          <Section maxWidth="full" border="bottom" tone="muted">
            <div className="py-20">
              <Stack gap={2} className="mb-12 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Roles
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Designed around real tenant roles.
                </h2>
                <p className="text-muted-foreground">
                  Four distinct audiences, each with a tailored surface and the exact permissions they need.
                </p>
              </Stack>
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
              <Stack gap={2} className="mb-12 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Surfaces
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  A portal for everyone.
                </h2>
                <p className="text-muted-foreground">
                  Dedicated interfaces for your staff, your customers, and the public.
                </p>
              </Stack>
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
                    <CardDescription>Self-service wallet top-ups, history, and reservations.</CardDescription>
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

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <Stack gap={2} className="mb-12 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Onboarding
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Get started in three steps.
                </h2>
              </Stack>
              <Grid cols={3} gap={4}>
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

          <Section maxWidth="full" border="bottom" tone="muted">
            <div className="py-20">
              <Stack gap={2} className="mb-8 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  FAQ
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Common questions.
                </h2>
              </Stack>
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
                Ready to upgrade your venue?
              </h2>
              <p className="max-w-prose text-balance text-muted-foreground">
                Create your venue in seconds — set up your floor plan, invite your staff, and open for business.
              </p>
              <Link
                href="/sign-up"
                className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
              >
                Create a venue
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
                  <CardTitle>About this venue</CardTitle>
                  <CardDescription>Details about this venue.</CardDescription>
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
