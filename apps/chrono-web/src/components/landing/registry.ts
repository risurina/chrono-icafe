import {
  buildLandingSectionRegistry,
  defineLandingSection,
  type LandingSectionContext,
  type ResolvedLandingConfig,
} from "agora";
import {
  TenantHero,
  TenantAbout,
  TenantContact,
  TenantFaq,
  TenantCta,
} from "./tenant-sections";

/**
 * Chrono's landing section vocabulary.
 *
 * The foundation owns the machinery; this file owns *which sections exist*.
 * Adding one is a single entry — pages render whatever
 * `resolveLandingSections()` returns, so no page file changes and a future app
 * re-skins by swapping this map rather than editing layout code.
 *
 * `defaultOrder` is spaced by 10 so a section can be slotted between two
 * others without renumbering the rest.
 */
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
      eyebrow: r.hero.eyebrow,
      primaryCta: r.hero.primaryCta,
      secondaryCta: r.hero.secondaryCta,
    }),
  }),
  about: defineLandingSection({
    key: "about",
    label: "About",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 20,
    Component: TenantAbout,
    propsFrom: (r: ResolvedLandingConfig) => ({
      title: r.about.title ?? "About us",
      body: r.about.body,
    }),
  }),
  contact: defineLandingSection({
    key: "contact",
    label: "Contact & location",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 30,
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
    defaultOrder: 40,
    Component: TenantFaq,
    propsFrom: (r: ResolvedLandingConfig) => ({ faqs: r.faqs }),
  }),
  cta: defineLandingSection({
    key: "cta",
    label: "Closing call to action",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 50,
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
