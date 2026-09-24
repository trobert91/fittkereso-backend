import {
  IdentifierPreview,
  SimulatedListingIdentifiers,
} from '@fittkereso-backend/product-scraper';

/**
 * One listing's identifiers as markdown lines — shared by the scrape and the
 * import simulation, so both read the same way.
 */
export function formatListingIdentifiers(
  identifiers: SimulatedListingIdentifiers,
  indent = '',
): string[] {
  const L: string[] = [];
  L.push(`${indent}- **externalId**: ${identifiers.externalId ?? '_none_'}`);
  L.push(`${indent}- **gtin**: ${formatIdentifier(identifiers.gtin)}`);
  L.push(`${indent}- **mpn**: ${formatIdentifier(identifiers.mpn)}`);
  if (identifiers.siblingIds !== undefined) {
    L.push(
      `${indent}- **declared siblings**: ${identifiers.siblingIds.length} (${identifiers.siblingIds.join(', ')})`,
    );
  }
  L.push(
    `${indent}- **spec rows sent to identity extraction**: ${identifiers.specRowsSent} of ${identifiers.specRowsTotal}`,
  );
  return L;
}

export function formatIdentifier(preview: IdentifierPreview): string {
  if (preview.outcome === 'absent') return '_none published_';
  if (preview.outcome === 'invalid') {
    return `\`${preview.raw}\` — INVALID, would not be stored`;
  }
  return preview.raw === preview.stored
    ? `\`${preview.stored}\``
    : `\`${preview.raw}\` → stored as \`${preview.stored}\``;
}
