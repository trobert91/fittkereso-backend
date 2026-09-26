import { isEqual, sortBy, uniqWith } from 'lodash';
import type { ProductSpecs, SpecDefinitionJsonSchema } from '@fittkereso-backend/database';
import { isSpecValueDefined } from '@fittkereso-backend/utils';
import type { ListingOfferSpec } from '../models/product-source-record-search-result';

/**
 * A listing's offer entries' specs, one per key: every value the entries
 * state, once each, labelled and ordered by the category's schema. Keys the
 * schema does not know keep their key as the label and sort last, as the
 * admin shows a listing's specs elsewhere.
 */
export function summarizeOfferSpecs(
  entries: ProductSpecs[],
  schema: SpecDefinitionJsonSchema | undefined,
): ListingOfferSpec[] {
  const properties = schema?.properties ?? {};
  const position = new Map(Object.keys(properties).map((key, index) => [key, index]));

  const valuesByKey = new Map<string, ProductSpecs[string][]>();
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      if (!isSpecValueDefined(value)) continue;
      valuesByKey.set(key, uniqWith([...(valuesByKey.get(key) ?? []), value], isEqual));
    }
  }

  return sortBy(
    [...valuesByKey.keys()],
    (key) => position.get(key) ?? Number.MAX_SAFE_INTEGER,
    (key) => key,
  ).map((key) => ({
    key,
    label: properties[key]?.title ?? key,
    unit: properties[key]?.meta?.unit,
    values: valuesByKey.get(key) ?? [],
  }));
}
