import type {
  ListingIdentityKey,
  ProductSourceRecord,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import {
  filterDefinedSpecs,
  inspectGtin,
  normalize,
  normalizeMpn,
} from '@fittkereso-backend/utils';
import { compact, difference, isEqual, pick, uniq } from 'lodash';

/**
 * The definition a key is made under. A stored key of another is ignored and
 * read off its record again, under this one, so changing what a key holds
 * moves no listing by itself.
 */
export const IDENTITY_KEY_VERSION = 1;

/** One offer's identifiers, in stored form. */
export interface KeyIdentifiers {
  gtin?: string;
  mpn?: string;
}

/**
 * A listing's identity key: what decides which product it is. `keySpecs` are
 * its category's primarySpecs and matcherSpecs; offer-level specs (size,
 * colour) are the offer's, not the product's.
 */
export function identityKeyOf(params: {
  brand: string | undefined;
  normalizedModel: string | null | undefined;
  identifiers: KeyIdentifiers[];
  /** Declared siblings, the listing's own id left out. */
  siblingIds: string[] | undefined;
  specs: ProductSpecs | undefined;
  keySpecs: string[];
}): ListingIdentityKey {
  return {
    version: IDENTITY_KEY_VERSION,
    brand: normalize(params.brand ?? ''),
    normalizedModel: params.normalizedModel ?? null,
    gtins: sortedUnique(params.identifiers.map((identifier) => identifier.gtin)),
    mpns: sortedUnique(params.identifiers.map((identifier) => identifier.mpn)),
    siblingIds: sortedUnique(params.siblingIds ?? []),
    specs: sortedSpecs(filterDefinedSpecs(pick(params.specs ?? {}, params.keySpecs))),
  };
}

/**
 * The key a listing's product was last decided under: the one its record
 * stores, else the one its stored listing gives (records written before keys
 * were stored, or under another definition). Undefined for a record whose
 * listing was never named: its product was found by its title alone, and
 * there is nothing a key could be compared with.
 */
export function storedIdentityKeyOf(
  record: ProductSourceRecord | undefined,
  keySpecs: string[],
): ListingIdentityKey | undefined {
  const stored = record?.scrapedProduct;
  if (!record || !stored?.model) return undefined;
  if (stored.identityKey?.version === IDENTITY_KEY_VERSION) return stored.identityKey;

  return identityKeyOf({
    brand: stored.brand,
    normalizedModel: record.normalizedModel,
    identifiers: (stored.offers ?? []).map((offer) => ({
      gtin: inspectGtin(offer.gtin).gtin,
      mpn: normalizeMpn(offer.mpn),
    })),
    siblingIds: (stored.siblingExternalIds ?? []).filter((id) => id !== stored.externalId),
    specs: stored.specs,
    keySpecs,
  });
}

/** What changed between two keys of one listing. */
export interface IdentityKeyChange {
  /**
   * Its brand or model changed, or an identifier it had is gone or another:
   * what it was found by no longer holds.
   */
  anchorsChanged: boolean;
  /** GTINs, MPNs and sibling ids it did not have before. */
  addedIdentifiers: string[];
  /** The key specs whose value was added, changed or dropped. */
  changedSpecs: string[];
}

/** Undefined when the two keys are the same. */
export function identityKeyChangeOf(
  before: ListingIdentityKey,
  after: ListingIdentityKey,
): IdentityKeyChange | undefined {
  const identifiersOf = (key: ListingIdentityKey) => [...key.gtins, ...key.mpns, ...key.siblingIds];
  const anchorsChanged =
    before.brand !== after.brand ||
    before.normalizedModel !== after.normalizedModel ||
    difference(identifiersOf(before), identifiersOf(after)).length > 0;
  const addedIdentifiers = difference(identifiersOf(after), identifiersOf(before));
  const changedSpecs = uniq([...Object.keys(before.specs), ...Object.keys(after.specs)])
    .filter((key) => !isEqual(before.specs[key], after.specs[key]))
    .sort();

  if (!anchorsChanged && addedIdentifiers.length === 0 && changedSpecs.length === 0) {
    return undefined;
  }
  return { anchorsChanged, addedIdentifiers, changedSpecs };
}

/** Whether a listing's extraction named it: only then is its key worth comparing. */
export function isNamed(listing: Pick<ScrapedProduct, 'model' | 'flags'>): boolean {
  return (
    !!listing.model &&
    !listing.flags?.includes('identity_failed') &&
    !listing.flags?.includes('identity_off')
  );
}

function sortedUnique(values: (string | undefined | null)[]): string[] {
  return uniq(compact(values)).sort();
}

function sortedSpecs(specs: ProductSpecs): ProductSpecs {
  return Object.fromEntries(
    Object.keys(specs)
      .sort()
      .map((key) => [key, specs[key]]),
  ) as ProductSpecs;
}
