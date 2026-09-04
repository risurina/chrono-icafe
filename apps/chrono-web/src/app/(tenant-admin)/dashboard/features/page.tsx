import { redirect } from "next/navigation";

// Moved under Settings. Redirect old bookmarks/links to the nested route.
export default function FeaturesRedirectPage() {
  redirect("/admin/settings/features");
}
