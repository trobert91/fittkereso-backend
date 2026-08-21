import { ProductSpecs } from '@fittkereso-backend/database';
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

function getOfferLevelKeys(
  categoryConfigService: CategoryConfigService,
  categorySlug: string | undefined,
): string[] {
  return categoryConfigService.getConfig(categorySlug)?.offerLevelSpecs ?? [];
}
