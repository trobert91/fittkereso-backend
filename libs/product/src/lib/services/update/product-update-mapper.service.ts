import { Injectable } from '@nestjs/common';
import { ProductModelUpdateDto } from '../../models/product-update.dto';
import {
  BrandRepository,
  ProductCategoryRepository,
  ProductEmbedding,
  ProductImageRepository,
  ProductModel,
  ProductSourceRecord,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { isUndefined, omit } from 'lodash';
import { ProductEmbeddingService } from '../product-embedding.service';
import { ProductNormalizerService } from '../product-normalizer.service';
import { CategoryConfigService } from '@fittkereso-backend/config';

@Injectable()
export class ProductUpdateMapperService {
  constructor(
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly brandRepo: BrandRepository,
    private readonly productImageRepo: ProductImageRepository,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly productNormalizer: ProductNormalizerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async mapDtoToEntity(
    dto: ProductModelUpdateDto,
    entity: ProductModel,
  ): Promise<ProductModel> {
    let hasNameChanged = false;
    // -------------------------------------
    // Simple primitive fields
    // -------------------------------------

    if (!isUndefined(dto.displayName)) {
      if (entity.displayName !== dto.displayName) {
        hasNameChanged = true;
      }
      entity.displayName = dto.displayName;
    }

    if (!isUndefined(dto.model)) {
      if (entity.model !== dto.model) {
        hasNameChanged = true;
      }
      entity.model = dto.model;
    }

    if (!isUndefined(dto.description)) {
      this.mapDescription(entity, dto.description);
    }

    if (!isUndefined(dto.enabled)) {
      entity.enabled = dto.enabled;
    }

    if (!isUndefined(dto.manualSpecs)) {
      this.mapManualSpecs(entity, dto.manualSpecs);
    }

    // -------------------------------------
    // Relations: Brand, ProductCategory
    // -------------------------------------
    if (!isUndefined(dto.brandId)) {
      if (entity.brand?.id !== dto.brandId) {
        hasNameChanged = true;
      }
      entity.brand = await this.brandRepo.findByIdOrFail(dto.brandId);
    }

    if (!isUndefined(dto.productCategoryId)) {
      entity.productCategory = await this.categoryRepo.findByIdOrFail(
        dto.productCategoryId,
      );
    }

    if (!isUndefined(dto.aliases)) {
      this.mapAliases(entity, dto.aliases);
    }

    if (!isUndefined(dto.mainImageId)) {
      // Do not fetch ProductImage, just set FK
      // because your relation has @JoinColumn()
      entity.mainImage = await this.productImageRepo.findByIdOrFail(
        dto.mainImageId,
      );
    }

    if (hasNameChanged) {
      await this.regenerateNameDependentFields(entity);
    }

    return entity;
  }

  private async regenerateNameDependentFields(entity: ProductModel) {
    entity.embedding = entity.embedding ?? new ProductEmbedding();
    entity.embedding.embedding =
      await this.embeddingService.createProductEmbedding({
        brand: entity.brand.name,
        model: entity.model,
        displayName: entity.displayName,
        category: entity.productCategory?.name,
      });
    const strategy =
      this.categoryConfigService.getConfig(entity.productCategory?.slug)
        ?.normalizationStrategy ?? 'full-sorted';
    entity.normalizedName = this.productNormalizer.normalizeProduct({
      brand: entity.brand.name,
      model: entity.model,
      displayName: entity.displayName,
      strategy,
    });
  }

  private mapAliases(entity: ProductModel, aliases: string[]) {
    // Ensure entity.aliases is initialized
    entity.aliases = entity.aliases ?? [];

    const existing = entity.aliases;

    // 1) Keep only aliases that still exist in the DTO
    const preserved = existing.filter((a) => aliases.includes(a.alias));

    // 2) Determine which aliases are new
    const preservedAliasStrings = preserved.map((a) => a.alias);
    const newAliasStrings = aliases.filter(
      (a) => !preservedAliasStrings.includes(a),
    );

    const newAliasEntities = newAliasStrings.map((alias) => ({
      alias,
      model: entity,
    })) as any;

    // 3) Final list = preserved existing + new ones
    entity.aliases = [...preserved, ...newAliasEntities];
  }

  private mapManualSpecs(entity: ProductModel, specs: ProductSpecs) {
    const record = this.adminRecordOf(entity);
    record.scrapedProduct = { ...record.scrapedProduct, specs };
    record.lastUpdated = new Date();
  }

  /**
   * The admin's description overrides every source's, so it lives on the
   * admin's record and ProductDescriptionService picks it from there; an
   * empty one removes the override. `lastUpdated` stays: it is the manual
   * specs' recency, which the spec merge's last tie-break reads.
   */
  private mapDescription(entity: ProductModel, description: string) {
    const text = description.trim();
    if (!text && !entity.sources?.some((record) => !record.source)) return;

    const record = this.adminRecordOf(entity);
    const rest = omit(record.scrapedProduct, 'description');
    record.scrapedProduct = text ? { ...rest, description: text } : rest;
  }

  /**
   * Admin-entered values have no ProductSource behind them (source: null) —
   * that's what distinguishes the admin's record from scraped ones. Created
   * when missing; `entity.sources` must be loaded, or every edit adds another.
   */
  private adminRecordOf(entity: ProductModel): ProductSourceRecord {
    entity.sources = entity.sources ?? [];
    const existing = entity.sources.find((record) => !record.source);
    if (existing) return existing;

    const record = new ProductSourceRecord();
    record.model = entity;
    record.source = null;
    record.scrapedProduct = {};
    record.lastUpdated = new Date();
    entity.sources.push(record);
    return record;
  }
}
