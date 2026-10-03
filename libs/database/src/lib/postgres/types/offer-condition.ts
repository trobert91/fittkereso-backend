export enum OfferCondition {
  new = 'new',
  used = 'used',
  refurbished = 'refurbished',
}

const OFFER_CONDITIONS = new Set<string>(Object.values(OfferCondition));

/**
 * One of the three values, ignoring case and surrounding whitespace — Google
 * Shopping's own `condition` values are exactly these. Anything else, a shop's
 * Hungarian label included, is undefined: a source config translates those
 * with `mapValue`.
 */
export function parseOfferCondition(value: unknown): OfferCondition | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return OFFER_CONDITIONS.has(normalized) ? (normalized as OfferCondition) : undefined;
}
