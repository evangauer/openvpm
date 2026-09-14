/** Quantities use at most three decimals, matching persisted medication units. */
export function isSupportedQuantity(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001
  );
}

/** Round each invoice line once to cents before summing and applying tax. */
export function quantityLineTotalCents(
  unitPriceCents: number,
  quantity: number,
): number {
  if (
    !Number.isSafeInteger(unitPriceCents) ||
    unitPriceCents < 0 ||
    !isSupportedQuantity(quantity) ||
    quantity < 0 ||
    quantity > 2_147_483_647
  )
    return NaN;
  const numerator =
    BigInt(unitPriceCents) * BigInt(Math.round(quantity * 1000));
  return Number((numerator + 500n) / 1000n);
}
