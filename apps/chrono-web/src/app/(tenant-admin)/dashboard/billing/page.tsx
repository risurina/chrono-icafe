import { redirect } from "next/navigation";

// Moved under Settings. Redirect old bookmarks/links to the nested route.
export default function BillingRedirectPage() {
  redirect("/dashboard/settings/billing");
}
