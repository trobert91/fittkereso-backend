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
import { isUndefined } from 'lodash';
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
      entity.description = dto.description;
    }

    if (!isUndefined(dto.enabled)) {
      entity.enabled = dto.enabled;
    }

    if (!isUndefined(dto.releaseYear)) {
      entity.releaseYear = dto.releaseYear;
    } else if (dto.releaseYear === '') {
      entity.releaseYear = undefined;
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
        ?.normalizationStrategy ?? 'digit-heuristic';
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
    entity.sources = entity.sources ?? [];

    // Admin-entered specs have no ProductSource behind them (source: null) —
    // that's what distinguishes them from scraped ProductSourceRecord rows.
    let manualSource = entity.sources.find((s) => !s.source);

    if (manualSource) {
      manualSource.specs = specs;
      manualSource.lastUpdated = new Date();
    } else {
      const newSource = new ProductSourceRecord();
      newSource.model = entity;
      newSource.source = null;
      newSource.specs = specs;
      newSource.lastUpdated = new Date();
      entity.sources.push(newSource);
    }
  }
}
