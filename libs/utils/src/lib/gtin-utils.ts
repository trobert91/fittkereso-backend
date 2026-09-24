/**
 * Canonical GTIN-14 for a raw barcode value, or `undefined` when it is not a
 * usable global identifier.
 *
 * A GTIN is matched across EVERY shop (see ProductScrapeUpdaterService's
 * identifier tiers), so a value that merely looks like one is worse than
 * none: it would attach one shop's listing to a different bike from another
 * shop. Hence the strictness:
 *
 * - **Digits only** once spaces, dots and hyphens are gone. Anything else —
 *   speedbike's `47112910603xx` placeholders — is not a barcode.
 * - **A GTIN length** (8, 12, 13 or 14). speedbike's GIANT/LIV rows carry
 *   7-digit article stubs (`5461000`) in `ean_code`.
 * - **A valid GS1 check digit**, which catches typos and truncation.
 * - **Not a restricted-circulation number** (GS1 prefixes 020–029, 040–049,
 *   200–299): those are a company's in-store codes, reused freely by every
 *   other company, so two shops' identical values say nothing about the
 *   product.
 *
 * Returned zero-padded to 14 digits, so an EAN-13 and the same item's UPC-12
 * or GTIN-14 form compare equal as strings. Padding never changes the check
 * digit — the GS1 weights run from the right.
 */
export function normalizeGtin(raw: unknown): string | undefined {
  const digits = toIdentifierText(raw)?.replace(/[\s.-]/g, '');
  if (!digits || !/^\d+$/.test(digits)) return undefined;
  if (![8, 12, 13, 14].includes(digits.length)) return undefined;

  const gtin = digits.padStart(14, '0');
  if (/^0+$/.test(gtin)) return undefined;
  if (!hasValidGs1CheckDigit(gtin)) return undefined;
  if (isRestrictedCirculation(gtin)) return undefined;

  return gtin;
}

/** What normalizeGtin made of a raw value: a GTIN, junk, or nothing at all. */
export type GtinOutcome = 'valid' | 'invalid' | 'absent';

/**
 * normalizeGtin plus the reason when it yields nothing.
 *
 * "The shop published nothing" and "the shop published something that is not a
 * barcode" look the same once normalized, but only the second is worth
 * noticing — a whole source turning invalid means a mapping points at the
 * wrong field.
 */
export function inspectGtin(raw: unknown): { gtin?: string; outcome: GtinOutcome } {
  const gtin = normalizeGtin(raw);
  if (gtin) return { gtin, outcome: 'valid' };
  const blank =
    raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  return { outcome: blank ? 'absent' : 'invalid' };
}

/**
 * Comparable form of a manufacturer part number (the manufacturer's own article
 * code — KTM's `1260040108`), or `undefined` when it is too short to identify
 * anything.
 *
 * Shops format the same code differently (`1260-040-108`, `1260 040108`), so
 * case, whitespace and hyphens are dropped. Shop-specific decoration, such as
 * the `MX` prefix speedbike's feed sometimes puts on KTM codes, is removed in
 * that source's config rather than here: it is one shop's quirk, not a
 * property of MPNs.
 *
 * Under 5 characters a code is more likely a size or colour index than an
 * article number, and an MPN is only ever matched within one brand, where a
 * short code would still collide.
 */
export function normalizeMpn(raw: unknown): string | undefined {
  const mpn = toIdentifierText(raw)?.toUpperCase().replace(/[\s-]/g, '');
  if (!mpn || mpn.length < 5) return undefined;
  return mpn;
}

// A feed parser or a JSON page can hand over a number; a 13-digit GTIN is well
// inside the safe-integer range, so its string form is exact.
function toIdentifierText(raw: unknown): string | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

/** GS1 mod-10 over a 14-digit string: weights 3,1,3,… from the left. */
function hasValidGs1CheckDigit(gtin14: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    sum += Number(gtin14[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(gtin14[13]);
}

// Checked on the GTIN-13 body (the 14-digit form minus its indicator digit),
// which is where a UPC-12 `2…`/`4…` in-store code lands as `02…`/`04…` too.
function isRestrictedCirculation(gtin14: string): boolean {
  const body = gtin14.slice(1);
  return body.startsWith('2') || body.startsWith('02') || body.startsWith('04');
}
