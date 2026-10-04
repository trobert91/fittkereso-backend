import { Injectable } from '@nestjs/common';
import type {
  Brand,
  ProductModel,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import { compact, flatMap, isArray, isNumber, isString, uniq } from 'lodash';
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
 * or a stored product — into one ProductMatchQuery. The only place a key is
 * built, so a listing's record and a query of it hold the same key.
 */
@Injectable()
export class ProductMatchQueryService {
  constructor(
    private readonly productNormalizer: ProductNormalizerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * A scraped listing, with the brand already resolved from it. One the
   * identity extraction did not name is searched by its title's words, and
   * can attach by none.
   */
  public ofListing(scrapedProduct: ScrapedProduct, brand: Brand): ProductMatchQuery {
    const { category } = scrapedProduct;
    const key = this.normalizedModelOf(scrapedProduct, brand.name);
    const titleKey = key
      ? undefined
      : this.keyOf(scrapedProduct, scrapedProduct.originalName, brand.name);
    return {
      brandId: brand.id,
      brandName: brand.name,
      categoryId: category.id,
      categorySlug: category.slug,
      keys: compact([key ?? titleKey]),
      keyed: !!key,
      model: scrapedProduct.model ?? scrapedProduct.originalName,
      specs: scrapedProduct.specs,
    };
  }

  /**
   * A stored product, loaded with `brand` and `productCategory`. Its keys
   * are its listings', which the finder loads.
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
      model: product.model,
      specs: product.specs,
    };
  }

  /**
   * A listing's normalizedModel: its `model` (the identity extraction's name
   * for it) normalized, without the words of its own brand and of
   * `resolvedBrandName`, and without the listing's values of the category's
   * `model.excludeSpecs` (its year, say), in case the extraction kept one.
   * Built from the listing alone, so the key its record stores and the key a
   * query of it compares are the same. Undefined without a model, or when
   * nothing is left.
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
    return this.keyOf(listing, listing.model, resolvedBrandName);
  }

  /**
   * A key for a name with no listing behind it — a stored product's own
   * model, when none of its listings was named. Searches and scores; never
   * attaches.
   */
  public keyOfName(name: string | undefined, brandName: string): string | undefined {
    return this.productNormalizer.normalizeModel({ text: name, brands: [brandName] });
  }

  private keyOf(
    listing: Pick<ScrapedProduct, 'brand' | 'category' | 'specs' | 'offers'>,
    text: string | undefined,
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
      text,
      brands: [listing.brand, resolvedBrandName],
      dropValues: uniq(dropValues),
    });
  }
}
