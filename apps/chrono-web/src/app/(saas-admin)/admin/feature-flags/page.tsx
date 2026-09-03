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
  Input,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Stack,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformFeatureListItem } from "agora";

/**
 * Low-cardinality, platform-wide resource (the code registry defines a fixed,
 * small set of keys) — a server list contract would be pure overhead, so this
 * loads the whole list once and filters client-side, per
 * `.ai/rules/data-listing.md`'s client-side allowance.
 */
export default function FeatureFlagsPage() {
  const [items, setItems] = useState<PlatformFeatureListItem[]>([]);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["feature-flags"].$get({ query: {} });
    if (!res.ok) {
      toast.error("Could not load feature flags.");
      setLoaded(true);
      return;
    }
    setItems((await res.json()).items as PlatformFeatureListItem[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const needle = q.trim().toLowerCase();
  const rows = needle
    ? items.filter(
        (i) =>
          i.key.toLowerCase().includes(needle) ||
          i.label.toLowerCase().includes(needle) ||
          i.category.toLowerCase().includes(needle),
      )
    : items;

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Feature flags</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide feature management. Turn a feature on or off globally, roll
          it out to a percentage of tenants, or restrict it to specific plans. The
          per-tenant overrides on each organization layer under these rules.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Features</CardTitle>
          <CardDescription>
            Each feature exists in the code registry; its global config is edited
            here. A feature with no saved config uses its registry defaults.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Search features…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Global default</TableHead>
                  <TableHead>Rollout</TableHead>
                  <TableHead>Plans</TableHead>
                  <TableHead>Overrides</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-sm text-muted-foreground"
                    >
                      {loaded ? "No features match." : "Loading…"}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((i) => (
                    <TableRow key={i.key}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{i.label}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {i.key}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>{i.category}</TableCell>
                      <TableCell>
                        {i.status === "disabled" ? (
                          <Badge variant="destructive">Disabled</Badge>
                        ) : (
                          <Badge variant="secondary">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell>{i.globalDefault ? "On" : "Off"}</TableCell>
                      <TableCell>
                        {i.rolloutPercentage === null
                          ? "—"
                          : `${i.rolloutPercentage}%`}
                      </TableCell>
                      <TableCell>
                        {i.planAvailability === null ? (
                          <span className="text-muted-foreground">All</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {i.planAvailability.map((p) => (
                              <Badge key={p} variant="outline">
                                {p}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{i.tenantOverrideCount}</TableCell>
                      <TableCell className="text-right">
                        <Link href={`/admin/feature-flags/${i.key}`}>
                          <Button variant="outline" size="sm">
                            Manage
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}
