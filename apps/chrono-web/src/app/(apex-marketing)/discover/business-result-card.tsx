"use client";

import type { BusinessDirectoryResult } from "@agora/chrono-api/business-lead";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  Row,
  Stack,
} from "agora/ui";
import { tenantHref } from "@/lib/tenant-links";

export function BusinessResultCard({
  business,
  onVisit,
}: {
  business: BusinessDirectoryResult;
  onVisit?: (organizationId: string) => void;
}) {
  const availability = business.liveAvailability;

  return (
    <Card data-testid="discover-result">
      <CardHeader>
        <Row justify="between" items="start" gap={3}>
          <Stack gap={1}>
            <CardTitle>{business.name}</CardTitle>
            <CardDescription>
              {/* Never invent a location — say plainly that none is listed. */}
              {business.locationText ?? "Location not listed yet"}
            </CardDescription>
          </Stack>
          {/* Rendered ONLY when the API actually returned availability. A
              business with no stations gets `null`, not `{0,0}`, so there is no
              misleading "0 of 0 available" line. */}
          {availability ? (
            <Badge variant="secondary" data-testid="discover-result-availability">
              {availability.available} of {availability.total} stations available now
            </Badge>
          ) : null}
        </Row>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={() => {
            onVisit?.(business.organizationId);
            window.open(tenantHref(business.slug), "_blank", "noopener,noreferrer");
          }}
        >
          Visit {business.name}
        </Button>
      </CardContent>
    </Card>
  );
}
