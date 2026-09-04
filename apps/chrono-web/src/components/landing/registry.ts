import {
  buildLandingSectionRegistry,
  defineLandingSection,
  type LandingSectionContext,
  type ResolvedLandingConfig,
} from "agora";
import {
  TenantHero,
  TenantStations,
  TenantRates,
  TenantSpecs,
  TenantGames,
  TenantTestimonials,
  TenantEvents,
  TenantAbout,
  TenantContact,
  TenantFaq,
  TenantCta,
  type TenantStationsProps,
} from "./tenant-sections";

/**
 * Chrono's own live-data shape, carried through
 * `LandingSectionContext.data` — the foundation's untyped seam for
 * request-time data (it cannot know an app's shape at its own build time).
 * Narrowed here, once, so every `propsFrom` below stays typed.
 */
export type ChronoLandingData = {
  stations?: {
    branches: TenantStationsProps["branches"];
    aggregate: TenantStationsProps["aggregate"];
  } | null;
};

const chronoData = (ctx: LandingSectionContext): ChronoLandingData =>
  (ctx.data ?? {}) as ChronoLandingData;

/**
 * Chrono's landing section vocabulary.
 *
 * The foundation owns the machinery; this file owns *which sections exist* and
 * *what they say before a tenant configures anything*. Adding one is a single
 * entry — pages render whatever `resolveLandingSections()` returns, so no page
 * file changes and a future app re-skins by swapping this map rather than
 * editing layout code.
 *
 * `defaultOrder` is spaced by 10 so a section can be slotted between two
 * others without renumbering the rest.
 */

/**
 * Placeholder content, so a brand-new tenant's page reads as finished rather
 * than half-empty. These are venue-shaped defaults, NOT claims about a specific
 * venue — each is replaced the moment the tenant fills the matching field.
 *
 * TODO: `rates` / `specs` / `games` / `testimonials` are not yet part of
 * `landingConfigSchema`. They become tenant-editable by extending chrono's
 * config with a `venue` block (`landingConfigSchema.extend({ … })`, per
 * `.ai/rules/business-app.md`) and reading it here — the components already
 * take the data as props, so only these `propsFrom` bodies change.
 */
const DEFAULTS = {
  specs: {
    cpu: "Ryzen 7 class CPU",
    gpu: "RTX-class graphics",
    monitor: "High-refresh gaming monitor",
    ram: "16GB dual-channel",
    peripherals: "Mechanical keyboard & gaming mouse",
    network: "Fibre internet",
    comfort: "Ergonomic gaming chairs",
  },
  games: [
    "Valorant",
    "Dota 2",
    "League of Legends",
    "CS2",
    "Mobile Legends",
    "Roblox",
    "Minecraft",
    "Steam library",
  ],
  badges: ["Fast stations", "Clean lounge", "Friendly community", "Competitive setup"],
} as const;

const HERO_GAME_TAGS = ["Valorant", "Dota 2", "CS2", "League of Legends"] as const;

export const CHRONO_LANDING_SECTIONS = buildLandingSectionRegistry({
  hero: defineLandingSection({
    key: "hero",
    label: "Hero",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 10,
    Component: TenantHero,
    propsFrom: (r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      title: r.hero.title ?? ctx.tenantName,
      subtitle: r.hero.subtitle,
      eyebrow: r.hero.eyebrow ?? "Gaming lounge & café",
      primaryCta: r.hero.primaryCta ?? { label: "View rates", href: "#rates" },
      secondaryCta: r.hero.secondaryCta ?? { label: "Find us", href: "#location" },
      branchName: ctx.tenantName,
      // Same live snapshot the station matrix renders, so the hero gauges can
      // never disagree with the grid below them.
      summary: chronoData(ctx).stations?.aggregate ?? null,
      specLines: [DEFAULTS.specs.gpu, DEFAULTS.specs.network].filter(Boolean),
      gameTags: HERO_GAME_TAGS,
    }),
  }),
  stations: defineLandingSection({
    key: "stations",
    label: "Station matrix",
    surface: "tenant",
    defaultEnabled: true,
    // Between hero (10) and rates (20) — a visitor checks whether there's a
    // free seat before they check what it costs.
    defaultOrder: 15,
    Component: TenantStations,
    propsFrom: (_r: ResolvedLandingConfig, ctx: LandingSectionContext) => {
      const live = chronoData(ctx).stations;
      return { branches: live?.branches ?? [], aggregate: live?.aggregate ?? null };
    },
  }),
  rates: defineLandingSection({
    key: "rates",
    label: "Rates",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 20,
    Component: TenantRates,
    propsFrom: () => ({}),
  }),
  specs: defineLandingSection({
    key: "specs",
    label: "Station specs",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 30,
    Component: TenantSpecs,
    propsFrom: () => ({ specs: DEFAULTS.specs }),
  }),
  games: defineLandingSection({
    key: "games",
    label: "Games",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 40,
    Component: TenantGames,
    propsFrom: () => ({ games: DEFAULTS.games }),
  }),
  about: defineLandingSection({
    key: "about",
    label: "About",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 50,
    Component: TenantAbout,
    propsFrom: (r: ResolvedLandingConfig) => ({
      title: r.about.title ?? "About us",
      body: r.about.body,
    }),
  }),
  testimonials: defineLandingSection({
    key: "testimonials",
    label: "Testimonials",
    surface: "tenant",
    // Off by default: real quotes are the tenant's to supply, and inventing
    // customer praise on their behalf would be fabricating a review.
    defaultEnabled: false,
    defaultOrder: 60,
    Component: TenantTestimonials,
    propsFrom: () => ({ badges: DEFAULTS.badges }),
  }),
  events: defineLandingSection({
    key: "events",
    label: "Events & tournaments",
    surface: "tenant",
    defaultEnabled: false,
    defaultOrder: 70,
    Component: TenantEvents,
    propsFrom: () => ({}),
  }),
  contact: defineLandingSection({
    key: "contact",
    label: "Contact & location",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 80,
    Component: TenantContact,
    propsFrom: (r: ResolvedLandingConfig) => r.contact,
  }),
  faq: defineLandingSection({
    key: "faq",
    label: "FAQ",
    surface: "tenant",
    // Off unless the tenant actually writes FAQs — an empty accordion is worse
    // than no section.
    defaultEnabled: false,
    defaultOrder: 90,
    Component: TenantFaq,
    propsFrom: (r: ResolvedLandingConfig) => ({ faqs: r.faqs }),
  }),
  cta: defineLandingSection({
    key: "cta",
    label: "Closing call to action",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 100,
    Component: TenantCta,
    propsFrom: (r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      tenantName: ctx.tenantName,
      cta: r.hero.primaryCta,
    }),
  }),
});

/** Labels for the dashboard's sections editor. */
export const TENANT_SECTION_CHOICES = Object.values(CHRONO_LANDING_SECTIONS).map(
  (def) => ({ key: def.key, label: def.label }),
);
