/**
 * A calendar year as a 4-digit number, or `undefined` when the value is not
 * one year.
 *
 * Shops write a model year every way there is — `2026`, `"2026"`, `"26"`,
 * `"'26"`, `"2026."` — and the identity gates compare what they are given: a
 * listing's `26` against a product's `2026` is a mismatch. Every writer of a
 * year field (a number field with `meta.format: 'year'` in the category
 * schema) converts through this, so two products compare the same number
 * whichever source each came from.
 *
 * - **Two digits mean 20xx**, with or without a leading apostrophe (straight or
 *   typographic): a product catalogue has no 19xx models.
 * - **A trailing dot is kept out**: it is how Hungarian writes a year
 *   ("2026.").
 * - **Otherwise the one year in the text**: "2024-es" or "MY 2026" name one
 *   year; "2025/2026" names two, and which one the shop meant is a guess.
 *
 * Plausibility is not judged here: whether 2031 is a real model year is the
 * category's `meta.min/max`, which the spec merge applies.
 */
export function normalizeYear(raw: unknown): number | undefined {
  if (Array.isArray(raw)) {
    return raw.length === 1 ? normalizeYear(raw[0]) : undefined;
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return undefined;
    if (raw >= 0 && raw <= 99) return 2000 + raw;
    return isFourDigitYear(raw) ? raw : undefined;
  }
  if (typeof raw !== 'string') return undefined;

  const text = raw.trim();
  const whole = text.match(/^['’‘`]?(\d{2}|\d{4})\.?$/);
  if (whole) {
    const year = Number(whole[1]);
    if (whole[1].length === 2) return 2000 + year;
    return isFourDigitYear(year) ? year : undefined;
  }

  const years = new Set(text.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? []);
  return years.size === 1 ? Number([...years][0]) : undefined;
}

function isFourDigitYear(value: number): boolean {
  return value >= 1900 && value <= 2099;
}
