import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductSourceRecordUpdaterService } from './product-source-record-updater.service';
import { ProductSpecValidatorService } from './product-spec-validator.service';
import { ProductMergeService } from '../merge/product-merge.service';

/**
 * Manual-spec-override entry point (admin "update manual specs" endpoint):
 * upserts a source: null ProductSourceRecord carrying the given specs, then
 * runs the same idempotent ProductMergeService.mergeSources recompute every
 * other update path uses — a manual edit participates in the merge as a
 * real candidate (see ProductSpecMergeService's Tier 4 recency/priority
 * tiebreak) rather than bypassing it.
 */
@Injectable()
export class ProductSpecUpdaterService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly sourceRecordUpdater: ProductSourceRecordUpdaterService,
    private readonly mergeService: ProductMergeService,
    private readonly validatorService: ProductSpecValidatorService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async updateManualSpecs(
    id: string,
    specs: ProductSpecs,
  ): Promise<ProductModel> {
    const product = await this.productRepo.findOneOrFail({
      where: { id },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
        `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
      ],
    });

    // Validate what the admin actually submitted, before it's merged with
    // other sources — a post-merge check could hide a bad manual value
    // behind an out-voting source, or blame the error on an unrelated field.
    // Unlike scrape-time validation (informational only, so the stored
    // schema's additionalProperties stays permissive for source-mapping
    // drift), a manual edit is free-typed input — reject keys outside the
    // category's known spec fields here rather than silently accepting them.
    const categorySlug = product.productCategory?.slug;
    const jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;
    const validation = this.validatorService.validateSpecs(
      jsonSchema ? { ...jsonSchema, additionalProperties: false } : undefined,
      specs,
    );
    if (!validation.isValid) {
      const fieldMessages = Object.entries(validation.errors).map(
        ([field, messages]) =>
          `${field}: ${(messages as string[]).join(', ')}`,
      );
      throw new BadRequestException({
        message: `Invalid product specs — ${fieldMessages.join('; ')}`,
        errors: validation.errors,
      });
    }

    await this.sourceRecordUpdater.upsertSourceRecord({
      model: product,
      source: null,
      scrapedProduct: { specs },
    });

    await this.mergeService.mergeSources(product);
    await this.productRepo.save(product);

    return product;
  }
}
