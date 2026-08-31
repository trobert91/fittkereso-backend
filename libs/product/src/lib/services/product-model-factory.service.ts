import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductEmbedding,
  ProductModel,
} from '@fittkereso-backend/database';
import { BrandResolutionService } from './resolution/brand-resolution.service';
import { ProductEmbeddingService } from './product-embedding.service';

/** Message thrown when no brand can be identified. Callers match on this to
 *  decide whether to skip the product rather than fail the whole operation. */
export const BRAND_NOT_IDENTIFIED = 'Brand could not be identified';

export interface NewProductModelParams {
  brandName?: string;
  displayName: string;
  model: string;
  categoryId: string;
  categoryName?: string;
  /** Identity key derived from brand/model/displayName at scrape time. */
  normalizedName: string;
}

/**
 * Builds the unsaved `ProductModel` shell a new product starts from — brand
 * resolution, category FK stub, identity fields, and the embedding.
 *
 * Shared so the two places that create products from scraped data — the scraper
 * (first sighting of a listing) and `ProductSplitService` (carving listings back
 * out into their own product) — produce identical shells rather than two
 * implementations that drift.
 *
 * Specs are deliberately not set here: they come from `mergeSources` once the
 * product's `ProductSourceRecord`s are attached, which is the single idempotent
 * path both callers already use.
 */
@Injectable()
export class ProductModelFactoryService {
  constructor(
    private readonly brandResolution: BrandResolutionService,
    private readonly embeddingService: ProductEmbeddingService,
  ) {}

  public async createShell(
    params: NewProductModelParams,
  ): Promise<ProductModel> {
    const brand = await this.brandResolution.resolve(
      params.brandName,
      params.displayName,
    );

    if (!brand?.entity) {
      throw new Error(BRAND_NOT_IDENTIFIED);
    }

    const model = new ProductModel();
    model.productCategory = { id: params.categoryId } as ProductCategory;
    model.brand = brand.entity;
    model.displayName = params.displayName;
    model.model = params.model;
    model.normalizedName = params.normalizedName;
    model.enabled = true;

    model.embedding = new ProductEmbedding();
    model.embedding.embedding =
      await this.embeddingService.createProductEmbedding({
        brand: model.brand.name,
        model: model.model,
        displayName: model.displayName,
        category: params.categoryName,
      });

    return model;
  }
}
