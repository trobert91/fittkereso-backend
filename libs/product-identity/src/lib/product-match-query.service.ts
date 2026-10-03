import { Injectable } from '@nestjs/common';
import type {
  Brand,
  ProductModel,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { listingNames } from '@fittkereso-backend/database';
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
   * A listing's matcherModel key: `text` (the identity extraction's
   * `matcherModel`) normalized with the listing's own brand, minus the
   * listing's values of the category's `matcherModel.excludeSpecs` (its year,
   * say), in case the extraction kept one. The only place a key is built, and
   * built from the listing alone, so the key its record stores and the key a
   * query of it compares are the same. Undefined when nothing is left.
   *
   * The offer-level values (size, colour) are left out by the prompt but not
   * dropped here: a size label doubles as a model word ("Team XL" is a model,
   * and a listing of it can carry "XL" as its frame size), and dropping it
   * would key two models alike.
   */
  public matcherModelKeyOf(
    listing: Pick<ScrapedProduct, 'brand' | 'category' | 'specs' | 'offers'>,
    text: string | undefined,
  ): string | undefined {
    const excluded =
      this.categoryConfigService.getConfig(listing.category.slug)?.matchingConfig
        ?.matcherModel?.excludeSpecs ?? [];
    const specSets = [
      listing.specs,
      ...(listing.offers ?? []).map((offer) => offer.specs),
    ];
    const dropValues = flatMap(specSets, (specs) =>
      flatMap(excluded, (key) => spokenValuesOf(specs?.[key])),
    );

    return this.productNormalizer.normalizeMatcherModel({
      text,
      brand: listing.brand,
      dropValues: uniq(dropValues),
    });
  }

  /**
   * The specs a matcherModel leaves out, as the extraction prompt names them:
   * the category's offer-level specs (they describe a listing, not a model)
   * and its `matchingConfig.matcherModel.excludeSpecs`.
   */
  public excludedSpecKeysOf(categorySlug: string): string[] {
    const config = this.categoryConfigService.getConfig(categorySlug);
    return uniq([
      ...(config?.offerLevelSpecs ?? []),
      ...(config?.matchingConfig?.matcherModel?.excludeSpecs ?? []),
    ]);
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
