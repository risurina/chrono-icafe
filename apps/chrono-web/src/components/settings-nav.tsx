import { Palette, KeyRound, ToggleRight, Webhook, Globe, CreditCard, ShieldCheck, Blocks, Users, Contact, TriangleAlert, ScrollText, FileText, type LucideIcon } from "lucide-react";

export type SettingsSection = {
  name: string;
  description: string;
  href: string;
  icon: LucideIcon;
  group: string;
};

export const SETTINGS_GROUP_ORDER = [
  "Business",
  "Team",
  "Developer",
  "Billing",
  "Danger zone",
] as const;

// Single source of truth for the settings submodules: drives both the
// secondary nav strip and the settings overview grid.
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    name: "Branding",
    description: "Logo, colors, and business identity.",
    href: "/admin/settings/branding",
    icon: Palette,
    group: "Business",
  },
  {
    name: "Landing page",
    description: "Public /about content shown at your business's host.",
    href: "/admin/settings/landing-page",
    icon: FileText,
    group: "Business",
  },
  {
    name: "Crew",
    description: "People and invitations for this business.",
    href: "/admin/settings/crew",
    icon: Users,
    group: "Team",
  },
  {
    name: "Roles",
    description: "Custom roles and what each one may do.",
    href: "/admin/settings/roles",
    icon: ShieldCheck,
    group: "Team",
  },
  {
    name: "Domains",
    description: "Map custom domains to this tenant.",
    href: "/admin/settings/domains",
    icon: Globe,
    group: "Business",
  },
  {
    name: "API Keys",
    description: "Programmatic access credentials.",
    href: "/admin/settings/api-keys",
    icon: KeyRound,
    group: "Developer",
  },
  {
    name: "Webhooks",
    description: "Outbound event notifications.",
    href: "/admin/settings/webhooks",
    icon: Webhook,
    group: "Developer",
  },
  {
    name: "Integrations",
    description: "Email and storage providers.",
    href: "/admin/settings/integrations",
    icon: Blocks,
    group: "Developer",
  },
  {
    name: "Features",
    description: "Toggle business capabilities.",
    href: "/admin/settings/features",
    icon: ToggleRight,
    group: "Business",
  },
  {
    name: "Billing",
    description: "Plan, usage, and invoices.",
    href: "/admin/settings/billing",
    icon: CreditCard,
    group: "Billing",
  },
  {
    name: "Security",
    description: "Sessions and two-factor authentication.",
    href: "/admin/settings/security",
    icon: ShieldCheck,
    group: "Team",
  },
  {
    name: "Customers",
    description: "Manage and export customer accounts.",
    href: "/admin/settings/customers",
    icon: Contact,
    group: "Team",
  },
  {
    name: "Audit Log",
    description: "History of actions taken in this business.",
    href: "/admin/settings/audit",
    icon: ScrollText,
    group: "Team",
  },
  {
    name: "Danger zone",
    description: "Suspend, export, or delete this business.",
    href: "/admin/settings/danger",
    icon: TriangleAlert,
    group: "Danger zone",
  },
];
