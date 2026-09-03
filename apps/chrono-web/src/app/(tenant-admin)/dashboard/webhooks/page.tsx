import { redirect } from "next/navigation";

// Moved under Settings. Redirect old bookmarks/links to the nested route.
export default function WebhooksRedirectPage() {
  redirect("/dashboard/settings/webhooks");
}
