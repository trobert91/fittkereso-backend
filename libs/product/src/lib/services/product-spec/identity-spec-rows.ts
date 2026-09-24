import { ScrapedProductSpec } from '@fittkereso-backend/database';

/**
 * The spec-table rows the LLM identity extraction gets from one listing: those
 * whose label is on the source's `identityExtraction.specRows` allowlist, or
 * every row when the source lists none.
 *
 * Labels compare the way specMapping labels do — ignoring case — and also
 * ignore surrounding and repeated whitespace, which shops are not consistent
 * about within one table. Accents are NOT folded: in Hungarian they tell
 * different words apart.
 *
 * Full spec unification never goes through this; it always sees the whole
 * table.
 */
export function selectIdentitySpecRows(
  rawSpecs: ScrapedProductSpec[] | undefined,
  specRows: string[] | undefined,
): ScrapedProductSpec[] {
  const rows = rawSpecs ?? [];
  if (!specRows?.length) return rows;

  const wanted = new Set(specRows.map(normalizeSpecRowLabel));
  return rows.filter((row) => wanted.has(normalizeSpecRowLabel(row.name)));
}

export function normalizeSpecRowLabel(label: string | undefined): string {
  return (label ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
