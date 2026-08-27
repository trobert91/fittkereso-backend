import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductSource,
  ProductSourceRecord,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { filterDefinedSpecs, normalizeUrl } from '@fittkereso-backend/utils';
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
    normalizedSourceName?: string;
  }): Promise<ProductSourceRecord | undefined> {
    const {
      model,
      source: newSource,
      scrapedProduct,
      externalId,
      normalizedSourceName,
    } = params;
    // Trimmed/trailing-slash-stripped once here so every ProductSourceRecord.url
    // stored is already normalized — callers matching against model.sources
    // (e.g. ProductScrapeUpdaterService.createOrUpdateOffers's per-offer
    // sourceRecord resolution) rely on this.
    const sourceUrl = params.sourceUrl ? normalizeUrl(params.sourceUrl) : undefined;
    // Label used only for metrics/logging — admin-entered specs have no
    // ProductSource (source: null), everything else is scraped.
    const sourceLabel = newSource?.name ?? 'manual';

    // Ensure sources loaded
    model.sources = model.sources ?? [];

    // Find existing source entry by URL, or create a new one
    let source = sourceUrl
      ? model.sources.find((s) => s.url === sourceUrl)
      : model.sources.find((s) => s.source?.id === newSource?.id && !s.url);

    // `scrapedProduct.specs` is absent (whether `scrapedProduct` itself is
    // undefined, e.g. a manual edit with no re-scrape, or defined without
    // `specs`, e.g. ProductDetailsPageScraperService.extractProduct's
    // offerSpecsHash/productSpecsHash-both-unchanged branch) when the caller
    // determined there is nothing new to re-extract. Report the existing row
    // as-is rather than overwriting its specs with `{}`.
    if (scrapedProduct?.specs === undefined && source) {
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
      ? {
          ...scrapedProduct,
          specs: processedSpecs,
          extractedSpecs: scrapedProduct.extractedSpecs
            ? this.processSpecs(scrapedProduct.extractedSpecs)
            : scrapedProduct.extractedSpecs,
          offerLevelDeterministicSpecs: scrapedProduct.offerLevelDeterministicSpecs
            ? this.processSpecs(scrapedProduct.offerLevelDeterministicSpecs)
            : scrapedProduct.offerLevelDeterministicSpecs,
          productLevelDeterministicSpecs: scrapedProduct.productLevelDeterministicSpecs
            ? this.processSpecs(scrapedProduct.productLevelDeterministicSpecs)
            : scrapedProduct.productLevelDeterministicSpecs,
        }
      : source.scrapedProduct;
    // Persisted as given, not recomputed — ProductDetailsPageScraperService.
    // extractProduct already hashed these exact (filtered) objects once, and
    // that same hash is what it compares against on the next scrape to
    // decide whether to skip the post-process call. Hashing again here from
    // a value that's been through this service's own processSpecs() risked
    // (and, before this, actually caused) the two hashes silently diverging
    // whenever processSpecs's filtering differed even slightly from
    // whatever the scraper's own hash input was — defeating both the
    // same-record skip and the cross-sibling reuse lookup. `scrapedProduct`
    // being defined but these two fields being absent (e.g. a manual
    // admin-entered specs edit with no re-scrape) is treated the same as "no
    // rawSpecs at all": no meaningful hash to store.
    if (scrapedProduct?.offerLevelDeterministicSpecs !== undefined) {
      source.offerSpecsHash = scrapedProduct.offerSpecsHash;
    } else if (scrapedProduct) {
      source.offerSpecsHash = undefined;
    }
    if (scrapedProduct?.productLevelDeterministicSpecs !== undefined) {
      source.productSpecsHash = scrapedProduct.productSpecsHash;
    } else if (scrapedProduct) {
      source.productSpecsHash = undefined;
    }
    source.externalId = externalId;
    source.specValid = validation.isValid;
    source.specErrors = validation.isValid ? {} : validation.errors;
    source.lastUpdated = new Date();
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
    return filterDefinedSpecs(specs);
  }
}
