import type { WebhookProviderAdapter } from "./contracts";

/**
 * A plain `Map`-backed registry, not a growing switch statement — adding a
 * provider is one `register()` call, never a branch in the ingress.
 *
 * Exported as a factory so tests can construct their own private instance
 * instead of mutating the shared production registry
 * (`.ai/plans/chrono/in-progress/centralized-webhook-architecture.md`, Phase 1,
 * step 3). `registry.ts`'s own module-level exports below are ONE instance of
 * this factory, for production use — the registry starts empty; no adapters
 * are registered by production code in Phase 1.
 */
export function createWebhookProviderRegistry() {
  const providers = new Map<string, WebhookProviderAdapter>();

  function register(id: string, adapter: WebhookProviderAdapter): void {
    if (providers.has(id)) {
      throw new Error(`Webhook provider "${id}" is already registered.`);
    }
    providers.set(id, adapter);
  }

  function get(id: string): WebhookProviderAdapter | null {
    return providers.get(id) ?? null;
  }

  return { register, get };
}

export const { register: registerWebhookProvider, get: getWebhookProvider } =
  createWebhookProviderRegistry();
