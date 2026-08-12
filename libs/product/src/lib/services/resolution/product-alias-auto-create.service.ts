import { Injectable } from '@nestjs/common';
import {
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductModel,
} from '@fittkereso-backend/database';
import { normalize } from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { BrandCacheService } from '../brand/brand-cache.service';

const MIN_ALIAS_LENGTH = 2;

export interface AliasAlternative {
  model: string;
  region?: string;
}

interface CreateAliasesParams {
  resolvedModel: ProductModel;
  brand: string;
  alternatives: AliasAlternative[];
  logContext?: Record<string, string>;
}

@Injectable()
export class ProductAliasAutoCreateService {
  private readonly logger = new CustomLogger(
    ProductAliasAutoCreateService.name,
  );

  constructor(
    private readonly productAliasRepository: ProductAliasRepository,
    private readonly brandCacheService: BrandCacheService,
  ) {}

  public async createAliasesFromAlternatives(
    params: CreateAliasesParams,
  ): Promise<void> {
    const { resolvedModel, alternatives, logContext } = params;

    for (const alternative of alternatives) {
      await this.createAlias(
        resolvedModel,
        alternative.model,
        alternative.region,
        logContext,
      );
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async createAlias(
    resolvedModel: ProductModel,
    rawAlias: string,
    region: string | undefined,
    logContext?: Record<string, string>,
  ): Promise<void> {
    const normalizedAlias = normalize(rawAlias);

    if (normalizedAlias.length < MIN_ALIAS_LENGTH) {
      return;
    }

    const canonicalNormalized = normalize(resolvedModel.model ?? '');
    if (normalizedAlias === canonicalNormalized) {
      return;
    }

    const rejectionReason = await this.validateAlias(
      normalizedAlias,
      resolvedModel,
    );
    if (rejectionReason) {
      this.logger.debug('Alias rejected by safeguard', {
        alias: normalizedAlias,
        productId: resolvedModel.id,
        productModel: resolvedModel.model,
        reason: rejectionReason,
        ...logContext,
      });
      return;
    }

    const existingAlias = await this.productAliasRepository.findOne({
      where: { alias: normalizedAlias, model: { id: resolvedModel.id } },
    });

    if (existingAlias) {
      return;
    }

    const alias = new ProductAlias();
    alias.alias = normalizedAlias;
    alias.model = resolvedModel;
    alias.source = ProductAliasSource.auto_generated;
    alias.region = region ?? undefined;

    await this.productAliasRepository.save(alias);

    this.logger.debug('Auto-created product alias', {
      alias: normalizedAlias,
      productId: resolvedModel.id,
      productModel: resolvedModel.model,
      region: region ?? 'unknown',
      ...logContext,
    });
  }

  // ─── Alias Validation ──────────────────────────────────────────────────────

  /**
   * Validates that a proposed alias is structurally related to the resolved product.
   * Returns a rejection reason string if invalid, or undefined if the alias passes.
   */
  private async validateAlias(
    normalizedAlias: string,
    resolvedModel: ProductModel,
  ): Promise<string | undefined> {
    const productModelName = normalize(resolvedModel.model ?? '');
    const productNormalizedName = resolvedModel.normalizedName ?? '';

    // Numeric token overlap: check against both model and normalizedName
    if (
      !this.hasNumericTokenOverlap(normalizedAlias, productModelName) &&
      !this.hasNumericTokenOverlap(normalizedAlias, productNormalizedName)
    ) {
      return 'no_numeric_overlap';
    }

    // Brand-only guard: alias must not be just a brand name
    if (await this.isBrandName(normalizedAlias)) {
      return 'alias_is_brand_name';
    }

    return undefined;
  }

  /**
   * Checks that at least one numeric group (e.g. "65", "95") is shared between
   * the alias and the product model. This catches completely unrelated models.
   *
   * If neither string has numeric groups, the check passes (purely alphabetic models).
   */
  private hasNumericTokenOverlap(alias: string, productModel: string): boolean {
    const aliasNumbers = alias.match(/\d+/g) ?? [];
    const modelNumbers = productModel.match(/\d+/g) ?? [];

    // If neither has numbers, allow (handles purely alphabetic models)
    if (aliasNumbers.length === 0 && modelNumbers.length === 0) {
      return true;
    }

    // If only one side has numbers, suspicious — reject
    if (aliasNumbers.length === 0 || modelNumbers.length === 0) {
      return false;
    }

    const modelNumberSet = new Set(modelNumbers);
    return aliasNumbers.some((numericGroup) =>
      modelNumberSet.has(numericGroup),
    );
  }

  /**
   * Rejects aliases that are just a brand name (would pollute fuzzy search results).
   */
  private async isBrandName(normalizedAlias: string): Promise<boolean> {
    const brands = await this.brandCacheService.getCachedBrands();
    return brands.some((brand) => normalize(brand.name) === normalizedAlias);
  }
}
