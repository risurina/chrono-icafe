import { toCents, fromCents } from '../wallet/money';

export function computeMeteredCharge(billableSeconds: number, ratePerHour: string): string {
  const rateCents = toCents(ratePerHour);
  const chargeCents = (rateCents * BigInt(billableSeconds) + 1800n) / 3600n;
  return fromCents(chargeCents);
}

export function capMoney(amount: string, ceiling: string): string {
  const amountCents = toCents(amount);
  const ceilingCents = toCents(ceiling);

  const flooredAmount = amountCents < 0n ? 0n : amountCents;
  const flooredCeiling = ceilingCents < 0n ? 0n : ceilingCents;

  const result = flooredAmount < flooredCeiling ? flooredAmount : flooredCeiling;
  
  return fromCents(result);
}
