import { ScrapedProductSpec } from '@fittkereso-backend/database';
import { selectIdentitySpecRows } from '@fittkereso-backend/product';
import { GtinOutcome, inspectGtin, normalizeMpn } from '@fittkereso-backend/utils';

/** One identifier as published, and what the import would store for it. */
export interface IdentifierPreview {
  raw?: string;
  /** What Offer.gtin / Offer.mpn would hold; absent when nothing is stored. */
  stored?: string;
  outcome: GtinOutcome;
}

/** The identity-relevant parts of one listing, as a run would see them. */
export interface SimulatedListingIdentifiers {
  externalId?: string;
  gtin: IdentifierPreview;
  mpn: IdentifierPreview;
  /** Declared sibling ids (scraping sources with detailPage.siblingIds only). */
  siblingIds?: string[];
  /** Spec-table rows the identity extraction would get, of the table's total. */
  specRowsSent: number;
  specRowsTotal: number;
}

export function previewGtin(raw: unknown): IdentifierPreview {
  const { gtin, outcome } = inspectGtin(raw);
  return { raw: toRaw(raw), stored: gtin, outcome };
}

// An MPN has no checksum, so "invalid" only ever means too short to store.
export function previewMpn(raw: unknown): IdentifierPreview {
  const text = toRaw(raw);
  const stored = normalizeMpn(raw);
  return {
    raw: text,
    stored,
    outcome: stored ? 'valid' : text ? 'invalid' : 'absent',
  };
}

export function previewListingIdentifiers(params: {
  externalId?: string;
  gtin: unknown;
  mpn: unknown;
  siblingIds?: string[];
  rawSpecs: ScrapedProductSpec[] | undefined;
  specRows: string[] | undefined;
}): SimulatedListingIdentifiers {
  return {
    externalId: params.externalId,
    gtin: previewGtin(params.gtin),
    mpn: previewMpn(params.mpn),
    siblingIds: params.siblingIds,
    specRowsSent: selectIdentitySpecRows(params.rawSpecs, params.specRows).length,
    specRowsTotal: params.rawSpecs?.length ?? 0,
  };
}

function toRaw(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text === '' ? undefined : text;
}
