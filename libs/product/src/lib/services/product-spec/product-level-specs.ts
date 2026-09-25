import {
  ProductSpecs,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { isEmpty, omit, pick } from 'lodash';

// Offer-level spec keys (e.g. frameSize, color) describe a purchasable
// variant/listing attribute, not the product model's identity — they're
// captured on Offer.specs instead (see ProductScrapeUpdaterService), so
// they must never land in the merged ProductModel.specs, or two listings
// of the same model in different sizes/colors would trip the model-level
// spec-mismatch gate in the resolution pipeline's filter stage.
export function getProductLevelSpecs(
  categoryConfigService: CategoryConfigService,
  specs: ProductSpecs,
  categorySlug: string | undefined,
): ProductSpecs {
  const offerLevelKeys = getOfferLevelKeys(categoryConfigService, categorySlug);
  return isEmpty(offerLevelKeys) ? specs : omit(specs, offerLevelKeys);
}

// The complement of getProductLevelSpecs — the subset of a merged spec
// object that belongs on Offer.specs instead. Kept symmetric with
// getProductLevelSpecs for callers that only have the merged object.
export function getOfferLevelSpecs(
  categoryConfigService: CategoryConfigService,
  specs: ProductSpecs,
  categorySlug: string | undefined,
): ProductSpecs {
  const offerLevelKeys = getOfferLevelKeys(categoryConfigService, categorySlug);
  return isEmpty(offerLevelKeys) ? {} : pick(specs, offerLevelKeys);
}

/**
 * The offer-level keys whose values are the shop's own name for the variant it
 * sells — free text, such as a colour ("BLACK/TITAN", "Olive Pearl"). Shops and
 * manufacturers use these names as marketing terms, so they are kept exactly
 * as the source writes them and never translated, by the mapping's translator
 * or by the LLM. Numbers and fixed-list fields are left out: a number is
 * parsed, and a fixed-list value has to be mapped onto the list.
 */
export function getVerbatimSpecKeys(
  schema: SpecDefinitionJsonSchema,
  offerLevelKeys: string[],
): string[] {
  return offerLevelKeys.filter((key) => {
    const property = schema.properties[key];
    return property?.type === 'string' && !property.enum?.length;
  });
}

function getOfferLevelKeys(
  categoryConfigService: CategoryConfigService,
  categorySlug: string | undefined,
): string[] {
  return categoryConfigService.getConfig(categorySlug)?.offerLevelSpecs ?? [];
}
