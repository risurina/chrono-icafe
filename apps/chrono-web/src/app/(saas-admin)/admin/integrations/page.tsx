"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  ListRow,
  Stack,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformIntegration } from "agora";

function ConnectionBadge({ status }: { status: PlatformIntegration["connectionStatus"] }) {
  if (status === "connected") return <Badge variant="success">Connected</Badge>;
  if (status === "error") return <Badge variant="warning">Error</Badge>;
  return <Badge variant="outline">Disconnected</Badge>;
}

const NO_PROVIDER_GROUP = "No provider configured";

type ProviderGroup = {
  provider: string;
  services: {
    category: PlatformIntegration["category"];
    label: string;
    description: string;
    isActive: boolean;
    connectionStatus: PlatformIntegration["connectionStatus"];
    hasCredentials: boolean;
    hasStoredSecret: boolean;
    lastSuccessfulConnectionAt: string | null;
  }[];
};

function groupByProvider(integrations: PlatformIntegration[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();

  for (const it of integrations) {
    const providerNames = it.providers.length > 0 ? it.providers : [NO_PROVIDER_GROUP];
    for (const providerName of providerNames) {
      const group = groups.get(providerName) ?? { provider: providerName, services: [] };
      group.services.push({
        category: it.category,
        label: it.label,
        description: it.description,
        isActive: it.provider === providerName,
        connectionStatus: it.connectionStatus,
        hasCredentials: it.hasCredentials,
        hasStoredSecret: it.hasStoredSecret,
        lastSuccessfulConnectionAt: it.lastSuccessfulConnectionAt,
      });
      groups.set(providerName, group);
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (a.provider === NO_PROVIDER_GROUP) return 1;
    if (b.provider === NO_PROVIDER_GROUP) return -1;
    return a.provider.localeCompare(b.provider);
  });
}

export default function PlatformIntegrationsPage() {
  const [integrations, setIntegrations] = useState<PlatformIntegration[]>([]);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"].integrations.$get();
    if (!res.ok) {
      toast.error("Could not load integrations.");
      return;
    }
    setIntegrations((await res.json()).integrations as PlatformIntegration[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const providerGroups = groupByProvider(integrations);

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide provider connections. Secrets are never displayed — only whether
          credentials are present.
        </p>
      </div>

      {integrations.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">No integrations defined.</p>
          </CardContent>
        </Card>
      ) : (
        providerGroups.map((group) => (
          <Card key={group.provider}>
            <CardHeader>
              <CardTitle>{group.provider}</CardTitle>
              <CardDescription>
                {group.services.length === 1
                  ? "Backs 1 service."
                  : `Backs ${group.services.length} services.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {group.services.map((svc) => (
                <ListRow
                  key={svc.category}
                  actions={
                    <Link href={`/admin/integrations/${svc.category}`}>
                      <Button variant="outline" size="sm">
                        Configure
                      </Button>
                    </Link>
                  }
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{svc.label}</p>
                      {svc.isActive ? (
                        <>
                          {svc.hasCredentials || svc.hasStoredSecret ? (
                            <Badge variant="secondary">Credentials present</Badge>
                          ) : (
                            <Badge variant="outline">No credentials</Badge>
                          )}
                          <ConnectionBadge status={svc.connectionStatus} />
                        </>
                      ) : (
                        <Badge variant="outline">Not selected</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{svc.description}</p>
                    {svc.isActive ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {svc.lastSuccessfulConnectionAt
                          ? `Last connected ${new Date(svc.lastSuccessfulConnectionAt).toLocaleString()}.`
                          : "Never connected."}
                      </p>
                    ) : null}
                  </div>
                </ListRow>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </Stack>
  );
}
