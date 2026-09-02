import { notFound } from "next/navigation";
import { getRequestTenant } from "agora/next";
import { ContactForm } from "./client";

export default async function ContactPage() {
  const tenant = await getRequestTenant();

  if (!tenant.slug && !tenant.host) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto max-w-lg p-4 md:p-8">
        <ContactForm tenantSlug={tenant.slug ?? null} tenantHost={tenant.host ?? null} />
      </main>
    </div>
  );
}
