import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductModelRepository,
  ProductModelSource,
  ProductSourceType,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductSpecMergeService } from './product-spec-merge.service';
import { ProductSpecSortService } from './product-spec-sort.service';
import { chain, groupBy, isBoolean, isEmpty, isNumber, maxBy } from 'lodash';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductSpecValidatorService } from './product-spec-validator.service';
import { ProductMetricsService } from '@fittkereso-backend/metrics';

@Injectable()
export class ProductSpecUpdaterService {
  private readonly logger = new CustomLogger(ProductSpecUpdaterService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly specMergeService: ProductSpecMergeService,
    private readonly specSortService: ProductSpecSortService,
    private readonly validatorService: ProductSpecValidatorService,
    private readonly productMetrics: ProductMetricsService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async remergeSpecsFromSources(model: ProductModel): Promise<void> {
    if (isEmpty(model.sources)) {
      return;
    }

    const latestSourcePerType = this.getLatestSourcePerType(model.sources);
    model.specs = await this.specMergeService.mergeSpecs(latestSourcePerType);
    model.orderedSpecs = await this.specSortService.sortSpecs(
      model.productCategory!,
      model.specs,
    );

    const categorySlug = model.productCategory?.slug;
    const jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;

    const finalValidation = this.validatorService.validateSpecs(
      jsonSchema,
      model.specs,
    );
    model.specValid = finalValidation.isValid;
    model.specErrors = !isEmpty(finalValidation.errors)
      ? finalValidation.errors
      : undefined;
  }

  public async updateManualSpecs(
    id: string,
    specs: ProductSpecs,
  ): Promise<ProductModel> {
    const product = await this.productRepo.findOneOrFail({
      where: { id },
      relations: [
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
      ],
    });

    await this.updateSpecsOnProduct({
      model: product,
      sourceType: ProductSourceType.manual,
      specs,
    });

    await this.productRepo.save(product);

    return product;
  }

  public async updateSpecsOnProduct(params: {
    model: ProductModel;
    sourceType: ProductSourceType;
    specs?: ProductSpecs;
    sourceUrl?: string;
    sourceName?: string;
    normalizedSourceName?: string;
  }): Promise<void> {
    const {
      model,
      sourceType,
      specs,
      sourceUrl,
      sourceName,
      normalizedSourceName,
    } = params;

    const categorySlug = model.productCategory?.slug;
    const jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;

    const processedSpecs = specs ? this.processSpecs(specs) : {};

    const validation = this.validatorService.validateSpecs(
      jsonSchema,
      processedSpecs,
    );

    if (!validation.isValid && categorySlug) {
      this.productMetrics.productSourceSpecValidationFailed(
        sourceType,
        categorySlug,
      );
    }

    // Ensure sources loaded
    model.sources = model.sources ?? [];

    // Revalidate existing sources of other types against current schema
    for (const source of model.sources) {
      if (source.type === sourceType) continue;
      source.specs = this.processSpecs(source.specs);
      const sourceValidation = this.validatorService.validateSpecs(
        jsonSchema,
        source.specs,
      );
      source.specValid = sourceValidation.isValid;
      source.specErrors = sourceValidation.isValid
        ? {}
        : sourceValidation.errors;
      if (!sourceValidation.isValid && categorySlug) {
        this.productMetrics.productSourceSpecValidationFailed(
          source.type,
          categorySlug,
        );
      }
    }

    // Find existing source entry by URL, or create a new one
    let source = sourceUrl
      ? model.sources.find((s) => s.url === sourceUrl)
      : model.sources.find((s) => s.type === sourceType && !s.url);

    if (!source) {
      source = new ProductModelSource();
      source.model = model;
      source.type = sourceType;
      model.sources.push(source);
    }

    source.url = sourceUrl;
    source.specs = processedSpecs;
    source.specValid = validation.isValid;
    source.specErrors = validation.isValid ? {} : validation.errors;
    source.lastUpdated = new Date();
    if (sourceName !== undefined) source.sourceName = sourceName;
    if (normalizedSourceName !== undefined)
      source.normalizedSourceName = normalizedSourceName;

    // For spec merging, use only the most recent entry per source type
    const latestSourcePerType = this.getLatestSourcePerType(model.sources);
    model.specs = await this.specMergeService.mergeSpecs(latestSourcePerType);
    model.orderedSpecs = await this.specSortService.sortSpecs(
      model.productCategory!,
      model.specs,
    );

    const finalValidation = this.validatorService.validateSpecs(
      jsonSchema,
      model.specs,
    );

    if (!finalValidation.isValid) {
      this.productMetrics.productSpecValidationFailed(sourceType);
    }

    model.specValid = finalValidation.isValid;
    model.specErrors = !isEmpty(finalValidation.errors)
      ? finalValidation.errors
      : undefined;

    this.logger.debug(
      `Updated specs for product model ${model.id ?? model.displayName} (${sourceType}). Valid: ${validation.isValid}`,
    );
  }

  private processSpecs(specs: ProductSpecs): ProductSpecs {
    return chain(specs)
      .toPairs()
      .filter(([_, value]) => this.isValueDefined(value))
      .sortBy(0)
      .fromPairs()
      .value();
  }

  private getLatestSourcePerType(
    sources: ProductModelSource[],
  ): ProductModelSource[] {
    const byType = groupBy(sources, (s) => s.type);
    return Object.values(byType).map(
      (entries) => maxBy(entries, (e) => e.lastUpdated)!,
    );
  }

  private isValueDefined(value: any): boolean {
    return isBoolean(value) || isNumber(value) || !isEmpty(value);
  }
}
