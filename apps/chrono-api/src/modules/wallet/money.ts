export function toCents(amount: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`Invalid money amount format: ${amount}`);
  }

  const isNegative = amount.startsWith("-");
  const absAmount = isNegative ? amount.slice(1) : amount;

  const parts = absAmount.split(".");
  const dollars = parts[0];
  const cents = parts[1] ?? "00";
  const paddedCents = cents.padEnd(2, "0");

  const totalCents = BigInt(dollars + paddedCents);
  return isNegative ? -totalCents : totalCents;
}

export function fromCents(cents: bigint): string {
  const isNegative = cents < 0n;
  const absCents = isNegative ? -cents : cents;

  const str = absCents.toString().padStart(3, "0");
  const dollars = str.slice(0, -2);
  const centsPart = str.slice(-2);

  return `${isNegative ? "-" : ""}${dollars}.${centsPart}`;
}

export function addMoney(a: string, b: string): string {
  const centsA = toCents(a);
  const centsB = toCents(b);
  return fromCents(centsA + centsB);
}

export function negateMoney(a: string): string {
  const cents = toCents(a);
  return fromCents(-cents);
}

export function isNegativeMoney(a: string): boolean {
  return toCents(a) < 0n;
}

export function multiplyMoney(a: string, n: number): string {
  const centsA = toCents(a);
  return fromCents(centsA * BigInt(Math.round(n)));
}

export function subtractMoney(a: string, b: string): string {
  const centsA = toCents(a);
  const centsB = toCents(b);
  return fromCents(centsA - centsB);
}

export function compareMoney(a: string, b: string): number {
  const centsA = toCents(a);
  const centsB = toCents(b);
  if (centsA < centsB) return -1;
  if (centsA > centsB) return 1;
  return 0;
}
