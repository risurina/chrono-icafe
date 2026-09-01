import { Palette, KeyRound, ToggleRight, Webhook, Globe, CreditCard, ShieldCheck, Blocks, Users, Contact, TriangleAlert, ScrollText, type LucideIcon } from "lucide-react";

export type SettingsSection = {
  name: string;
  description: string;
  href: string;
  icon: LucideIcon;
  group: string;
};

export const SETTINGS_GROUP_ORDER = [
  "Workspace",
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
    description: "Logo, colors, and workspace identity.",
    href: "/dashboard/settings/branding",
    icon: Palette,
    group: "Workspace",
  },
  {
    name: "Members",
    description: "People and invitations for this workspace.",
    href: "/dashboard/settings/members",
    icon: Users,
    group: "Team",
  },
  {
    name: "Roles",
    description: "Custom roles and what each one may do.",
    href: "/dashboard/settings/roles",
    icon: ShieldCheck,
    group: "Team",
  },
  {
    name: "Domains",
    description: "Map custom domains to this tenant.",
    href: "/dashboard/settings/domains",
    icon: Globe,
    group: "Workspace",
  },
  {
    name: "API Keys",
    description: "Programmatic access credentials.",
    href: "/dashboard/settings/api-keys",
    icon: KeyRound,
    group: "Developer",
  },
  {
    name: "Webhooks",
    description: "Outbound event notifications.",
    href: "/dashboard/settings/webhooks",
    icon: Webhook,
    group: "Developer",
  },
  {
    name: "Integrations",
    description: "Email and storage providers.",
    href: "/dashboard/settings/integrations",
    icon: Blocks,
    group: "Developer",
  },
  {
    name: "Features",
    description: "Toggle workspace capabilities.",
    href: "/dashboard/settings/features",
    icon: ToggleRight,
    group: "Workspace",
  },
  {
    name: "Billing",
    description: "Plan, usage, and invoices.",
    href: "/dashboard/settings/billing",
    icon: CreditCard,
    group: "Billing",
  },
  {
    name: "Security",
    description: "Sessions and two-factor authentication.",
    href: "/dashboard/settings/security",
    icon: ShieldCheck,
    group: "Team",
  },
  {
    name: "Customers",
    description: "Manage and export customer accounts.",
    href: "/dashboard/settings/customers",
    icon: Contact,
    group: "Team",
  },
  {
    name: "Audit Log",
    description: "History of actions taken in this workspace.",
    href: "/dashboard/settings/audit",
    icon: ScrollText,
    group: "Team",
  },
  {
    name: "Danger zone",
    description: "Suspend, export, or delete this workspace.",
    href: "/dashboard/settings/danger",
    icon: TriangleAlert,
    group: "Danger zone",
  },
];
