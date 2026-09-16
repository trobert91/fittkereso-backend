import { Injectable } from '@nestjs/common';
import type {
  Brand,
  ProductModel,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import type { ProductMatchQuery } from './types';

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

  /** A scraped listing, with the brand already resolved from it. */
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
        model: scrapedProduct.model,
        displayName: scrapedProduct.displayName,
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
