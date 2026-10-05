import {
  BrandIdentifierSpec,
  ProductSpecs,
  SpecDefinitionJsonSchema,
  SpecDefinitionProperty,
} from '@fittkereso-backend/database';
import {
  filterDefinedSpecs,
  hashSpecs,
  normalizeYear,
} from '@fittkereso-backend/utils';
import { compact, isNil, omit, pick, toLower, trim } from 'lodash';

/**
 * Folds a source's dedicated `releaseYear` value into `modelYear` when the
 * label-based mapping left it empty, so downstream code has one place to look
 * whichever extraction produced the year. Some sources state the year outside
 * their spec table and read it with the `releaseYear` target instead.
 *
 * The value arrives after the spec normaliser has run, and a pipeline without
 * `cast: number` hands over a string, so it is converted here: a year that
 * isn't one is not folded in at all.
 */
export function foldReleaseYear(specs: ProductSpecs, releaseYear: unknown): void {
  if (specs['modelYear'] !== undefined) return;
  const year = normalizeYear(releaseYear);
  if (year !== undefined) specs['modelYear'] = year;
}

/** What a brand identifier rule reads off a listing. */
export interface BrandIdentifiedListing {
  /** The listing's brand as the source wrote it. */
  brand: string | undefined;
  /** Its offers' manufacturer identifiers; a shop's own ids are never read. */
  offers: { mpn?: string | null; gtin?: string | null }[] | undefined;
}

/**
 * Folds in the spec values the listing's brand writes into its own article
 * numbers or barcodes (ProductCategoryConfig.brandIdentifierSpecs) — KTM's
 * model year and frame, say, which every shop's MPN carries whether or not its
 * spec table states them.
 *
 * Runs after the spec mapping and `foldReleaseYear` and only fills what they
 * left empty: a value the shop states is its own reading of the listing. Per
 * spec, the first rule that matches one of the listing's identifiers wins. A
 * rule with `values` reads the captured code through it, and a code it doesn't
 * list matches nothing. The value is typed as the schema field reads (a year
 * through `normalizeYear`); one the field can't hold is left out.
 */
export function foldBrandIdentifierSpecs(
  specs: ProductSpecs,
  listing: BrandIdentifiedListing,
  rulesByBrand: Record<string, BrandIdentifierSpec[]> | undefined,
  schema: SpecDefinitionJsonSchema,
): void {
  const brand = toLower(trim(listing.brand));
  const rules = Object.entries(rulesByBrand ?? {}).find(
    ([name]) => toLower(trim(name)) === brand,
  )?.[1];
  if (!brand || !rules?.length) return;

  const identifiers = {
    mpn: compact((listing.offers ?? []).map((offer) => trim(offer.mpn ?? ''))),
    gtin: compact((listing.offers ?? []).map((offer) => trim(offer.gtin ?? ''))),
  };
  for (const rule of rules) {
    if (!isNil(specs[rule.spec])) continue;
    const pattern = new RegExp(rule.pattern);
    for (const identifier of identifiers[rule.identifier]) {
      const captured = identifier.match(pattern)?.[1];
      if (captured === undefined) continue;
      const text = rule.values ? rule.values[captured] : `${rule.prefix ?? ''}${captured}`;
      if (text === undefined) continue;
      const value = toSpecValue(text, schema.properties[rule.spec]);
      if (value === undefined) continue;
      specs[rule.spec] = value;
      break;
    }
  }
}

/** Text as a value of the schema field: a number, a year, or an allowed string. */
function toSpecValue(
  text: string,
  property: SpecDefinitionProperty | undefined,
): number | string | undefined {
  if (property?.type === 'number') {
    if (property.meta?.format === 'year') return normalizeYear(text);
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
  }
  if (property?.type !== 'string') return undefined;
  if (!property.enum?.length) return text;
  return property.enum.find((value) => toLower(value) === toLower(text));
}

/**
 * The deterministic spec mapping, split into its two halves and hashed.
 *
 * The two halves are disjoint by construction, which is the point: an
 * offer-level-only difference between sibling variants (a different frameSize,
 * say) must never invalidate the expensive, shared product-identity half.
 */
export interface SplitDeterministicSpecs {
  offerLevelDeterministicSpecs: ProductSpecs;
  productLevelDeterministicSpecs: ProductSpecs;
  offerSpecsHash: string;
  productSpecsHash: string;
}

/**
 * Split a deterministic spec mapping by offer-level keys and hash each half.
 *
 * Shared by every importer rather than inlined per path, because these hashes
 * ARE the cost control — they are what skips the two LLM post-process calls on
 * an unchanged product — and two implementations of them would eventually
 * disagree about which keys or which filtering went into a hash, silently
 * defeating the cache for one path.
 *
 * `filterDefinedSpecs` runs before hashing so that hashing, the LLM calls'
 * input and persistence all see exactly the same object. Without it a key a
 * normalization pass mapped but could not type-convert (present, valued
 * `undefined`) made two byte-identical spec objects hash differently depending
 * on when in the pipeline they were hashed.
 */
export function splitDeterministicSpecs(
  specs: ProductSpecs,
  offerLevelKeys: string[],
): SplitDeterministicSpecs {
  const offerLevelDeterministicSpecs = filterDefinedSpecs(
    pick(specs, offerLevelKeys),
  );
  const productLevelDeterministicSpecs = filterDefinedSpecs(
    omit(specs, offerLevelKeys),
  );

  return {
    offerLevelDeterministicSpecs,
    productLevelDeterministicSpecs,
    offerSpecsHash: hashSpecs(offerLevelDeterministicSpecs),
    productSpecsHash: hashSpecs(productLevelDeterministicSpecs),
  };
}
