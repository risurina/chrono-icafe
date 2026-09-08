"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  Badge,
  Button,
  Skeleton,
  Grid,
  Stack,
} from "agora/ui";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { useMemberArea } from "@/components/member/member-area-context";
import { formatCurrency, formatMinutes } from "@/lib/member/format";
import { getCreditProducts, type CreditProduct } from "@/lib/member/credits";
import { getActivePromos, type ActivePromo } from "@/lib/member/promos";

export default function MemberPromosPage() {
  const { member } = useMemberArea();
  const [products, setProducts] = useState<CreditProduct[]>([]);
  const [promos, setPromos] = useState<ActivePromo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // Guest mode — both calls below are member-only (`memberMiddleware()`)
    // and would 401 with no `tenantMember` row yet.
    if (!member) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [p, promoRes] = await Promise.all([getCreditProducts(), getActivePromos()]);
    if (p.data) setProducts(p.data);
    if (promoRes.data) setPromos(promoRes.data);
    setLoading(false);
  }, [member]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="Promos"
        description="Credit packs you can buy from your wallet, and current promotions."
        actions={<RefreshButton onRefresh={load} />}
      />

      <Stack gap={3}>
        <h2 className="text-sm font-medium text-muted-foreground">Credit packs</h2>
        {loading ? (
          <Grid cols={3} gap={4}>
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </Grid>
        ) : products.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credit packs are available right now.</p>
        ) : (
          <Grid cols={3} gap={4} data-testid="credit-product-grid">
            {products.map((product) => (
              <Card key={product.id}>
                <CardHeader>
                  <CardTitle className="text-base">{product.name}</CardTitle>
                  <CardDescription>{formatMinutes(product.quantityMinutes)} of playtime</CardDescription>
                </CardHeader>
                <CardFooter className="flex items-center justify-between">
                  <span className="text-lg font-semibold">{formatCurrency(product.priceAmount)}</span>
                  <Link href={`/member/promos/${product.id}`}>
                    <Button size="sm">View</Button>
                  </Link>
                </CardFooter>
              </Card>
            ))}
          </Grid>
        )}
      </Stack>

      <Stack gap={3}>
        <h2 className="text-sm font-medium text-muted-foreground">Running promotions</h2>
        {promos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active promotions right now.</p>
        ) : (
          <Stack gap={3}>
            {promos.map((promo) => (
              <Card key={promo.id}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    {promo.name}
                    <Badge variant="secondary">{promo.code}</Badge>
                  </CardTitle>
                  <CardDescription>
                    {promo.description}
                    {promo.branchName ? ` — ${promo.branchName}` : ""}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
