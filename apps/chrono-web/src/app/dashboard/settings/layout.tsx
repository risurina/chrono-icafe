"use client";

import { SettingsLayout, type SettingsNavGroup } from "agora/ui";
import { SETTINGS_SECTIONS, SETTINGS_GROUP_ORDER } from "@/components/settings-nav";

export default function SettingsLayoutPage({
  children,
}: {
  children: React.ReactNode;
}) {
  const groups: SettingsNavGroup[] = SETTINGS_GROUP_ORDER.map((label) => ({
    label,
    items: SETTINGS_SECTIONS.filter((s) => s.group === label).map((s) => ({
      name: s.name,
      href: s.href,
      icon: s.icon,
    })),
  }));

  return <SettingsLayout groups={groups}>{children}</SettingsLayout>;
}
