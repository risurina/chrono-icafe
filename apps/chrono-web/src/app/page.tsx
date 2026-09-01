import Link from "next/link";
import {
  Building2,
  ShieldCheck,
  Globe,
  Layers,
  Map,
  Check,
  X,
  Crown,
  Settings2,
  User,
  KeyRound,
  LifeBuoy,
  ShieldCheck as ShieldIcon,
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
  Testimonial,
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
        icon: Building2,
        title: "Multi-tenant by default",
        description:
          "Every signup provisions its own workspace, subdomain, and membership roles.",
      },
      {
        icon: ShieldCheck,
        title: "Isolated at the database",
        description:
          "Forced Postgres row-level security keeps every tenant's data apart — not just app-level filters.",
      },
      {
        icon: Globe,
        title: "Custom domains",
        description:
          "Tenants can verify their own domain and serve the same app under their own brand.",
      },
      {
        icon: Layers,
        title: "Built to extend",
        description:
          "Typed contracts, RBAC, and a shared UI kit make new tenant-scoped modules fast to add.",
      },
    ];

    const withoutAgora = [
      "Rolling your own tenant isolation and hoping app-level filters never leak a row",
      "Wiring auth, roles, and custom domains from scratch on every new project",
      "Client and server drifting out of sync with no shared contract",
    ];
    const withAgora = [
      "Forced Postgres row-level security enforces isolation at the database, not just app code",
      "Auth, roles, and custom domains ship pre-wired via Better Auth + Hono",
      "Shared Zod contracts keep the API and UI in lockstep",
    ];

    const roles = [
      {
        icon: Crown,
        name: "Owner",
        description: "Every permission, including billing and transferring or deleting the tenant.",
      },
      {
        icon: Settings2,
        name: "Admin",
        description: "Everything except billing and tenant-level actions like delete or transfer.",
      },
      {
        icon: User,
        name: "Staff",
        description: "Scoped to the essentials — create projects, no admin surface.",
      },
    ];

    const steps = [
      {
        title: "Create a workspace",
        description: "Sign up provisions your tenant, subdomain, and makes you the owner.",
      },
      {
        title: "Invite your team",
        description: "Assign owner, admin, or staff roles — or compose a custom role from the same permissions.",
      },
      {
        title: "Build your first module",
        description: "Copy the project pattern to ship a new tenant-scoped table, route, and page.",
      },
    ];

    const stats = [
      { label: "Isolation model", value: "Forced RLS" },
      { label: "System roles", value: "3 + custom" },
      { label: "Domain support", value: "Sub + custom" },
      { label: "Framework", value: "Next.js 15" },
    ];

    const testimonials = [
      {
        quote:
          "The forced row-level security saved us weeks — we didn't have to write or trust a single app-level tenant filter.",
        name: "Priya M.",
        role: "Backend engineer",
      },
      {
        quote:
          "Copying the project pattern for our first real module took an afternoon, not a sprint.",
        name: "Dae-ho K.",
        role: "Full-stack developer",
      },
      {
        quote:
          "Roles, custom domains, and typed contracts were already wired — we shipped our MVP straight on top.",
        name: "Sam R.",
        role: "Founding engineer",
      },
    ];

    const faqs = [
      {
        q: "How is tenant data isolated?",
        a: "Every tenant table has forced row-level security in Postgres, scoped by tenant_id. Isolation is enforced at the database — not just by an app-level WHERE clause.",
      },
      {
        q: "Can each tenant use a custom domain?",
        a: "Yes. A verified custom domain resolves to the same tenant as its subdomain, with no separate deployment.",
      },
      {
        q: "What handles authentication?",
        a: "Better Auth, with separate staff and customer logins per tenant, and session-based role resolution on every request.",
      },
      {
        q: "Is this a hosted product?",
        a: "No — it's a starting codebase, not a hosted product. You own it, deploy it, and operate it yourself wherever you run Postgres and Node.",
      },
      {
        q: "How do roles and permissions work?",
        a: "Three system roles (staff, admin, owner) plus tenant-defined custom roles, all built from the same permission vocabulary and enforced server-side.",
      },
      {
        q: "What does it cost to run?",
        a: "There's no license fee — it's a codebase you own. Your only ongoing cost is hosting: Postgres (e.g. Neon), a Node server for the API, and wherever you deploy the Next.js app.",
      },
    ];

    return (
      <PageShell data-density="comfortable">
        <SiteHeader
          maxWidth="full"
          brand={
            <>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Map className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span>Agora</span>
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
                Agora · Multi-tenant base
              </Badge>
              <h1 className="text-balance text-5xl font-bold tracking-tight sm:text-7xl">
                The foundation for multi-tenant apps.
              </h1>
              <p className="max-w-2xl text-balance text-lg text-muted-foreground sm:text-xl">
                Next.js + Hono + Neon + Drizzle + Better Auth. Each tenant gets its own
                subdomain or custom domain, with separate staff and customer logins,
                isolated by Postgres row-level security.
              </p>
              <Row wrap justify="center" gap={3} className="pt-2">
                <Link
                  href="/sign-up"
                  className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
                >
                  Create a workspace
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
              <p className="text-sm text-muted-foreground">
                No credit card required · Free to start
              </p>
              <Row wrap justify="center" gap={2} className="pt-4">
                {["Next.js", "Hono", "Neon", "Drizzle", "Better Auth"].map((tech) => (
                  <Badge key={tech} variant="outline">
                    {tech}
                  </Badge>
                ))}
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
                  Why Agora
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Everything a multi-tenant SaaS needs, out of the box.
                </h2>
                <p className="text-muted-foreground">
                  A production-shaped starting point, not a toy scaffold.
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
                  Why not roll your own
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  A production-shaped starting point, not a toy scaffold.
                </h2>
              </Stack>
              <Grid cols={2} gap={4}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base text-muted-foreground">
                      Without a foundation
                    </CardTitle>
                  </CardHeader>
                  <CardFooter>
                    <Stack gap={3} className="w-full">
                      {withoutAgora.map((item) => (
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
                    <CardTitle className="text-base">With Agora</CardTitle>
                  </CardHeader>
                  <CardFooter>
                    <Stack gap={3} className="w-full">
                      {withAgora.map((item) => (
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

          <Section maxWidth="full" border="bottom">
            <div className="py-20">
              <Stack gap={2} className="mb-12 max-w-prose">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  What developers say
                </span>
                <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
                  Built by developers who&apos;d rather ship the product.
                </h2>
                <p className="text-muted-foreground">
                  Illustrative feedback from engineers who've built on this scaffold.
                </p>
              </Stack>
              <Grid cols={3} gap={4}>
                {testimonials.map((t) => (
                  <Testimonial key={t.name} {...t} />
                ))}
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
                  Three system roles, enforced server-side — plus custom roles a tenant
                  can compose from the same permissions.
                </p>
              </Stack>
              <Grid cols={3} gap={4}>
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
                Ready to spin up your workspace?
              </h2>
              <p className="max-w-prose text-balance text-muted-foreground">
                Create a tenant in seconds — you&apos;ll get your own subdomain,
                owner account, and dashboard immediately.
              </p>
              <Link
                href="/sign-up"
                className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
              >
                Create a workspace
              </Link>
            </Stack>
          </Section>
        </Main>

        <SiteFooter
          maxWidth="full"
          brand={<span>© {currentYear} Agora. All rights reserved.</span>}
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
      icon: KeyRound,
      title: "Manage your account",
      description: "Sign in any time to view and manage your account details.",
    },
    {
      icon: ShieldIcon,
      title: "Secure by default",
      description: "Your data is kept private and isolated from every other account.",
    },
    {
      icon: LifeBuoy,
      title: "Get support fast",
      description: "Staff can sign in separately to help manage your account.",
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
              Sign in to your account, or create one to get started.
            </p>
            <Row wrap justify="center" gap={3} className="pt-2">
              <Link
                href="/portal/sign-up"
                className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
              >
                Create account
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
            <Grid cols={2} gap={4} className="mx-auto max-w-2xl">
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
            </Grid>
          </div>
        </Section>
      </Main>

      <SiteFooter maxWidth="full" brand={<span>© {currentYear} {heading}</span>} />
    </PageShell>
  );
}
