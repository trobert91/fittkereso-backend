import { Injectable } from '@nestjs/common';
import type {
  Brand,
  ProductModel,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import {
  listingNames,
  modelExcludedSpecKeys,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import { flatMap, isArray, isNumber, isString, uniq } from 'lodash';
import type { ProductMatchQuery } from './types';

/**
 * The words a spec value would appear as in a model name: a string or a
 * number as written, each item of a list. A yes/no value has none.
 */
function spokenValuesOf(value: ProductSpecs[string]): string[] {
  if (isArray(value)) return value.filter(isString);
  if (isString(value) || isNumber(value)) return [String(value)];
  return [];
}

/**
 * Turns what the finder is asked about — a listing that isn't a product yet,
 * or a stored product — into one ProductMatchQuery. The only place a name key
 * is built, so a product and a listing of it get the same key.
 */
@Injectable()
export class ProductMatchQueryService {
  constructor(
    private readonly productNormalizer: ProductNormalizerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * A scraped listing, with the brand already resolved from it. One the
   * identity extraction did not name is keyed on its title.
   */
  public ofListing(
    scrapedProduct: ScrapedProduct,
    brand: Brand,
  ): ProductMatchQuery {
    const { category } = scrapedProduct;
    const key = this.normalizedModelOf(scrapedProduct, brand.name);
    return {
      brandId: brand.id,
      brandName: brand.name,
      categoryId: category.id,
      categorySlug: category.slug,
      nameKey: this.nameKeyOf({
        brandName: brand.name,
        ...listingNames(scrapedProduct),
        categorySlug: category.slug,
      }),
      specs: scrapedProduct.specs,
      matcherModelKeys: key ? [key] : [],
    };
  }

  /**
   * A stored product, loaded with `brand` and `productCategory`. The key is
   * rebuilt from its names rather than read from `normalizedName`, which older
   * rows may have built from a scraped brand string.
   */
  public ofProduct(product: ProductModel): ProductMatchQuery {
    const { brand, productCategory } = product;
    if (!brand || !productCategory) {
      throw new Error(
        `Product ${product.id} needs brand and productCategory loaded`,
      );
    }

    return {
      productId: product.id,
      brandId: brand.id,
      brandName: brand.name,
      categoryId: productCategory.id,
      categorySlug: productCategory.slug,
      nameKey: this.nameKeyOf({
        brandName: brand.name,
        model: product.model,
        displayName: product.displayName,
        categorySlug: productCategory.slug,
      }),
      specs: product.specs,
    };
  }

  /**
   * A listing's normalizedModel: its `model` (the identity extraction's name
   * for it) normalized, without the words of its own brand and of
   * `resolvedBrandName`, and without the listing's values of the category's
   * `model.excludeSpecs` (its year, say), in case the extraction kept one.
   * The only place a key is built, and built from the listing alone, so the
   * key its record stores and the key a query of it compares are the same.
   * Undefined without a model, or when nothing is left.
   *
   * The offer-level values (size, colour) are left out by the prompt but not
   * dropped here: a size label doubles as a model word ("Team XL" is a model,
   * and a listing of it can carry "XL" as its frame size), and dropping it
   * would key two models alike.
   */
  public normalizedModelOf(
    listing: Pick<ScrapedProduct, 'brand' | 'model' | 'category' | 'specs' | 'offers'>,
    resolvedBrandName?: string,
  ): string | undefined {
    const excluded =
      this.categoryConfigService.getConfig(listing.category.slug)?.matchingConfig
        ?.model?.excludeSpecs ?? [];
    const specSets = [
      listing.specs,
      ...(listing.offers ?? []).map((offer) => offer.specs),
    ];
    const dropValues = flatMap(specSets, (specs) =>
      flatMap(excluded, (key) => spokenValuesOf(specs?.[key])),
    );

    return this.productNormalizer.normalizeModel({
      text: listing.model,
      brands: [listing.brand, resolvedBrandName],
      dropValues: uniq(dropValues),
    });
  }

  /**
   * Whether the category's name matches need equal keys
   * (`matchingConfig.model.required`): the rule that acts. The other one
   * still runs, in shadow.
   */
  public requiresMatcherModel(categorySlug: string): boolean {
    return (
      this.categoryConfigService.getConfig(categorySlug)?.matchingConfig?.model
        ?.required === true
    );
  }

  /**
   * The specs a model leaves out, as the extraction prompt names them: the
   * category's offer-level specs (they describe a listing, not a model) and
   * its `matchingConfig.model.excludeSpecs`.
   */
  public excludedSpecKeysOf(categorySlug: string): string[] {
    return modelExcludedSpecKeys(this.categoryConfigService.getConfig(categorySlug));
  }

  /**
   * The name key rule: the model (else the display name) with the resolved
   * brand's name stripped, normalized with the category's strategy — the rule
   * ProductNameMergeService writes `normalizedName` with. Throws when there's
   * no name at all.
   */
  public nameKeyOf(params: {
    brandName: string;
    model?: string;
    displayName?: string;
    categorySlug: string;
  }): string {
    const strategy =
      this.categoryConfigService.getConfig(params.categorySlug)
        ?.normalizationStrategy ?? 'full-sorted';

    return this.productNormalizer.normalizeProduct({
      brand: params.brandName,
      model: params.model,
      displayName: params.displayName,
      strategy,
    });
  }
}
