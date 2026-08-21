import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductSource,
  ProductSourceRecord,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { chain, isBoolean, isEmpty, isNumber } from 'lodash';
import { hashRawSpecs } from '@fittkereso-backend/utils';
import { ProductSpecValidatorService } from './product-spec-validator.service';
import { ProductMetricsService } from '@fittkereso-backend/metrics';

/**
 * Upserts the one ProductSourceRecord for a (model, url) pair — mutation
 * only, no cross-source merge logic. Callers must follow up with
 * ProductMergeService.mergeSources(model) to recompute ProductModel's
 * specs/identity fields from all of its sources; this service never
 * touches ProductModel itself, so the upsert is safe to call repeatedly
 * and independently of when/whether a merge happens.
 */
@Injectable()
export class ProductSourceRecordUpdaterService {
  private readonly logger = new CustomLogger(ProductSourceRecordUpdaterService.name);

  constructor(
    private readonly validatorService: ProductSpecValidatorService,
    private readonly productMetrics: ProductMetricsService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async upsertSourceRecord(params: {
    model: ProductModel;
    source: ProductSource | null;
    scrapedProduct?: Partial<ScrapedProduct>;
    externalId?: string;
    sourceUrl?: string;
    sourceName?: string;
    normalizedSourceName?: string;
  }): Promise<ProductSourceRecord | undefined> {
    const {
      model,
      source: newSource,
      scrapedProduct,
      externalId,
      sourceUrl,
      sourceName,
      normalizedSourceName,
    } = params;
    // Label used only for metrics/logging — admin-entered specs have no
    // ProductSource (source: null), everything else is scraped.
    const sourceLabel = newSource?.name ?? 'manual';

    // Ensure sources loaded
    model.sources = model.sources ?? [];

    // Find existing source entry by URL, or create a new one
    let source = sourceUrl
      ? model.sources.find((s) => s.url === sourceUrl)
      : model.sources.find((s) => s.source?.id === newSource?.id && !s.url);

    // `scrapedProduct` is absent when the caller already determined (via
    // rawSpecsHash comparison) that this listing's raw spec table is
    // unchanged since the last scrape — see
    // ProductDetailsPageScraperService.extractProduct. Nothing to
    // re-extract; just report the existing row as-is.
    if (scrapedProduct === undefined && source) {
      return source;
    }

    const categorySlug = model.productCategory?.slug;
    const jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;

    const processedSpecs = scrapedProduct?.specs
      ? this.processSpecs(scrapedProduct.specs)
      : {};

    const validation = this.validatorService.validateSpecs(
      jsonSchema,
      processedSpecs,
    );

    if (!validation.isValid && categorySlug) {
      this.productMetrics.productSourceSpecValidationFailed(
        sourceLabel,
        categorySlug,
      );
    }

    // Revalidate existing sources other than the one being updated against
    // current schema — a category's jsonSchema can change independently of
    // any particular source being re-scraped, and the per-row
    // specValid/specErrors (shown in the admin UI's Sources tab) should
    // reflect that even for rows this call doesn't otherwise touch.
    for (const existingSource of model.sources) {
      if (existingSource.source?.id === newSource?.id) continue;
      const existingSpecs = existingSource.scrapedProduct?.specs;
      if (!existingSpecs) continue;
      const processedExisting = this.processSpecs(existingSpecs);
      if (existingSource.scrapedProduct) {
        existingSource.scrapedProduct = {
          ...existingSource.scrapedProduct,
          specs: processedExisting,
        };
      }
      const sourceValidation = this.validatorService.validateSpecs(
        jsonSchema,
        processedExisting,
      );
      existingSource.specValid = sourceValidation.isValid;
      existingSource.specErrors = sourceValidation.isValid
        ? {}
        : sourceValidation.errors;
      if (!sourceValidation.isValid && categorySlug) {
        this.productMetrics.productSourceSpecValidationFailed(
          existingSource.source?.name ?? 'manual',
          categorySlug,
        );
      }
    }

    if (!source) {
      source = new ProductSourceRecord();
      source.model = model;
      source.source = newSource;
      model.sources.push(source);
    }

    source.url = sourceUrl;
    source.scrapedProduct = scrapedProduct
      ? { ...scrapedProduct, specs: processedSpecs }
      : source.scrapedProduct;
    source.rawSpecsHash = scrapedProduct?.rawSpecs
      ? hashRawSpecs(scrapedProduct.rawSpecs)
      : undefined;
    source.externalId = externalId;
    source.specValid = validation.isValid;
    source.specErrors = validation.isValid ? {} : validation.errors;
    source.lastUpdated = new Date();
    if (sourceName !== undefined) source.sourceName = sourceName;
    if (normalizedSourceName !== undefined)
      source.normalizedSourceName = normalizedSourceName;

    this.logger.debug(
      `Upserted source record for product model ${model.id ?? model.displayName} (${sourceLabel}). Valid: ${validation.isValid}`,
    );

    return source;
  }

  private processSpecs(
    specs: NonNullable<ScrapedProduct['specs']>,
  ): NonNullable<ScrapedProduct['specs']> {
    return chain(specs)
      .toPairs()
      .filter(([_, value]) => this.isValueDefined(value))
      .sortBy(0)
      .fromPairs()
      .value();
  }

  private isValueDefined(value: any): boolean {
    return isBoolean(value) || isNumber(value) || !isEmpty(value);
  }
}
