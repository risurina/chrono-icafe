import { runCreditExpirySweepOnce } from "./expiry";
import { withAdmin } from "agora/db";
import { chronoCreditGrant, chronoCreditGrantLedgerEntry } from "./schema";
import { eq, and } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import assert from "node:assert";

async function main() {
  // Ensure we can connect and wipe test data safely
  if (!process.env.DATABASE_URL_ADMIN && !process.env.DB_DRIVER) {
    console.log("Skipping credit expiry sweep test (no DB configured)");
    process.exit(0);
  }
  
  await withAdmin(async (tx) => {
    // 1. Seed tenant and member
    const tenantId = createId();
    const memberId = createId();
    
    await tx.insert(base.organization).values({
      id: tenantId,
      name: "Sweep Test Tenant",
      slug: `sweep-test-${Date.now()}`,
    });
    
    await tx.insert(base.tenantMember).values({
      id: memberId,
      tenantId,
      email: `sweep-test-${Date.now()}@example.com`,
      name: "Sweep Test Member",
      passwordHash: "dummy",
    });

    // 2. Seed an expired grant
    const expiredGrantId = createId();
    const pastDate = new Date(Date.now() - 86400000); // 1 day ago
    
    await tx.insert(chronoCreditGrant).values({
      id: expiredGrantId,
      tenantId,
      memberId,
      originalQuantity: 100,
      remainingQuantity: 100,
      expiresAt: pastDate,
      status: "granted",
    });

    // 3. Seed an active grant (should be ignored)
    const activeGrantId = createId();
    const futureDate = new Date(Date.now() + 86400000); // 1 day future
    
    await tx.insert(chronoCreditGrant).values({
      id: activeGrantId,
      tenantId,
      memberId,
      originalQuantity: 100,
      remainingQuantity: 100,
      expiresAt: futureDate,
      status: "granted",
    });

    // 4. Seed an already consumed grant (should be ignored)
    const consumedGrantId = createId();
    
    await tx.insert(chronoCreditGrant).values({
      id: consumedGrantId,
      tenantId,
      memberId,
      originalQuantity: 100,
      remainingQuantity: 0,
      expiresAt: pastDate,
      status: "depleted", // NOT granted
    });
    
    console.log("Data seeded, running sweep...");
    
    const result = await runCreditExpirySweepOnce();
    assert.strictEqual(result.expired, 1, "Exactly one grant should have been swept");

    // 5. Verify the state
    const [sweptGrant] = await tx.select().from(chronoCreditGrant).where(eq(chronoCreditGrant.id, expiredGrantId));
    assert.strictEqual(sweptGrant?.status, "expired", "The expired grant should have status 'expired'");
    assert.strictEqual(sweptGrant?.remainingQuantity, 0, "The expired grant should have remainingQuantity 0");

    const [activeGrant] = await tx.select().from(chronoCreditGrant).where(eq(chronoCreditGrant.id, activeGrantId));
    assert.strictEqual(activeGrant?.status, "granted", "The active grant should have status 'granted'");
    assert.strictEqual(activeGrant?.remainingQuantity, 100, "The active grant should have remainingQuantity 100");

    const [consumedGrant] = await tx.select().from(chronoCreditGrant).where(eq(chronoCreditGrant.id, consumedGrantId));
    assert.strictEqual(consumedGrant?.status, "depleted", "The consumed grant should have status 'depleted'");
    assert.strictEqual(consumedGrant?.remainingQuantity, 0, "The consumed grant should have remainingQuantity 0");
    
    const ledgerEntries = await tx.select().from(chronoCreditGrantLedgerEntry).where(and(eq(chronoCreditGrantLedgerEntry.grantId, expiredGrantId), eq(chronoCreditGrantLedgerEntry.type, "expired")));
    assert.strictEqual(ledgerEntries.length, 1, "There should be one 'expired' ledger entry for the swept grant");
    assert.strictEqual(ledgerEntries[0]?.quantityDelta, -100, "The ledger entry quantityDelta should be -100");
    assert.strictEqual(ledgerEntries[0]?.quantityAfter, 0, "The ledger entry quantityAfter should be 0");
    
    // Cleanup seeded data
    await tx.delete(chronoCreditGrant).where(eq(chronoCreditGrant.tenantId, tenantId));
    await tx.delete(base.tenantMember).where(eq(base.tenantMember.tenantId, tenantId));
    await tx.delete(base.organization).where(eq(base.organization.id, tenantId));
    
    console.log("Sweep test passed!");
  });
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
