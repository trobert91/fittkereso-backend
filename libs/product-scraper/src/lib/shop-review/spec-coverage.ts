import { ProductCategoryConfig, SpecKeyCountRow } from '@fittkereso-backend/database';

/** Why a spec key matters to the category: its role in config.json. */
export type SpecKeyTag = 'primary' | 'matcher' | 'offer' | 'filter';

/** How many of a source's listings in one category carry one spec key. */
export interface SpecKeyCoverage {
  key: string;
  tags: SpecKeyTag[];
  /** Listings whose deterministic mapping filled it. */
  extracted: number;
  /** Listings that have it after the LLM pass. */
  specs: number;
  /** Listings with it in an offer entry's specs (offer-level keys). */
  offer: number;
  /** Products of those listings that have it, whichever seller filled it. */
  product: number;
}

export interface CategorySpecCoverage {
  slug: string;
  /** Attached listings: the base of the listing shares. */
  listings: number;
  /** Their distinct products: the base of `product`. */
  products: number;
  /** Every key of the category's schema, in schema order. */
  keys: SpecKeyCoverage[];
  /** Keys no listing and no product has, in any layer. */
  neverFilled: string[];
  /**
   * Keys the LLM fills where the deterministic mapping mostly doesn't: under
   * LLM_ONLY_MAX_EXTRACTED of the listings by mapping, at least
   * LLM_ONLY_MIN_SPECS after the LLM. A mapping could do that work for free.
   */
  llmOnly: string[];
}

export const LLM_ONLY_MAX_EXTRACTED = 0.2;
export const LLM_ONLY_MIN_SPECS = 0.6;

/** Schema keys stored outside specs (the product's Brand relation), so never counted. */
export const NON_SPEC_SCHEMA_KEYS = ['brand'];

/** The category config's roles for each key. */
export function specKeyTags(config: ProductCategoryConfig | undefined): Map<string, SpecKeyTag[]> {
  const tags = new Map<string, SpecKeyTag[]>();
  const tag = (keys: string[] | undefined, value: SpecKeyTag) => {
    for (const key of keys ?? []) tags.set(key, [...(tags.get(key) ?? []), value]);
  };
  tag(config?.primarySpecs, 'primary');
  tag(config?.matcherSpecs, 'matcher');
  tag(config?.offerLevelSpecs, 'offer');
  tag(
    config?.filterSpecs?.map((filter) => filter.key),
    'filter',
  );
  return tags;
}

/**
 * One category's spec coverage for one source, from the counted rows
 * (ProductSourceRecordReviewRepository.specKeyCounts, already narrowed to
 * that source and category). Keys outside the schema are left out: nothing
 * reads them.
 */
export function buildSpecCoverage(params: {
  slug: string;
  listings: number;
  products: number;
  rows: SpecKeyCountRow[];
  schemaKeys: string[];
  config: ProductCategoryConfig | undefined;
}): CategorySpecCoverage {
  const counts = new Map<string, Omit<SpecKeyCoverage, 'key' | 'tags'>>();
  for (const row of params.rows) {
    const entry = counts.get(row.key) ?? { extracted: 0, specs: 0, offer: 0, product: 0 };
    if (row.layer === 'extracted') entry.extracted = row.count;
    else if (row.layer === 'specs') entry.specs = row.count;
    else if (row.layer === 'offer') entry.offer = row.count;
    else entry.product = row.count;
    counts.set(row.key, entry);
  }
  const tags = specKeyTags(params.config);
  const keys = params.schemaKeys.filter((key) => !NON_SPEC_SCHEMA_KEYS.includes(key)).map((key) => ({
    key,
    tags: tags.get(key) ?? [],
    ...(counts.get(key) ?? { extracted: 0, specs: 0, offer: 0, product: 0 }),
  }));
  const share = (count: number) => (params.listings > 0 ? count / params.listings : 0);

  return {
    slug: params.slug,
    listings: params.listings,
    products: params.products,
    keys,
    neverFilled: keys
      .filter((key) => key.extracted + key.specs + key.offer + key.product === 0)
      .map((key) => key.key),
    llmOnly: keys
      .filter(
        (key) =>
          share(key.extracted) < LLM_ONLY_MAX_EXTRACTED && share(key.specs) >= LLM_ONLY_MIN_SPECS,
      )
      .map((key) => key.key),
  };
}
