import { Injectable } from '@nestjs/common';
import {
  OrderedSpec,
  ProductCategory,
  ProductModel,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class ProductSpecContextService {
  private readonly logger = new CustomLogger(ProductSpecContextService.name);

  constructor(private readonly categoryConfigService: CategoryConfigService) {}

  public getSpecsForContext(
    model: ProductModel,
    category?: ProductCategory,
    loggingContext?: Record<string, string>,
  ): string[] {
    if (!model.orderedSpecs?.length) {
      this.logger.warn(`No specs found for product model ${model.id}`, {
        ...loggingContext,
        productModelId: model.id,
      });
      return [];
    }

    const primarySpecs = category?.slug
      ? this.categoryConfigService.getConfig(category.slug)?.primarySpecs
      : undefined;
    if (!primarySpecs?.length) {
      this.logger.warn(
        `No primarySpecs configured for product category ${category?.id} while getting spec text for product model ${model.id}`,
        { productModelId: model.id },
      );
      return [];
    }

    return this.primaryOrderedSpecs(model.orderedSpecs, primarySpecs).map(
      (spec) => String(spec.value),
    );
  }

  public getExtractionOrderedSpecs(
    orderedSpecs: OrderedSpec[] | undefined,
    category?: ProductCategory,
    /** Optional cap on the number of specs returned. Order is preserved
     *  (category's `primarySpecs` order). */
    limit?: number,
  ): OrderedSpec[] {
    if (!orderedSpecs?.length) return [];

    const primarySpecs = category?.slug
      ? this.categoryConfigService.getConfig(category.slug)?.primarySpecs
      : undefined;
    if (!primarySpecs?.length) return [];

    const ordered = this.primaryOrderedSpecs(orderedSpecs, primarySpecs);
    return limit != null ? ordered.slice(0, limit) : ordered;
  }

  private primaryOrderedSpecs(
    orderedSpecs: OrderedSpec[],
    primarySpecs: string[],
  ): OrderedSpec[] {
    return primarySpecs
      .map((key) => orderedSpecs.find((spec) => spec.key === key))
      .filter(
        (spec): spec is OrderedSpec =>
          spec !== undefined && spec.value !== undefined,
      );
  }
}
