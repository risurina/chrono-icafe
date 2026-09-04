import { redirect } from "next/navigation";
import { SETTINGS_SECTIONS } from "@/components/settings-nav";

export default function SettingsIndexPage() {
  redirect(SETTINGS_SECTIONS[0]?.href ?? "/admin");
}
