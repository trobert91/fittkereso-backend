import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductSource,
  ProductSourceRecord,
  ScrapedOffer,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  filterDefinedSpecs,
  normalizeUrl,
  storedOfferExternalId,
} from '@fittkereso-backend/utils';
import { ProductSpecValidatorService } from './product-spec-validator.service';
import { ProductMetricsService } from '@fittkereso-backend/metrics';

/**
 * Upserts the one ProductSourceRecord of a (source, externalId) listing —
 * mutation only, no cross-source merge logic. Callers must follow up with
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
    /** The listing's key (listingExternalIdOf). Required with a source; the admin's record has none. */
    externalId?: string;
    sourceUrl?: string;
    normalizedSourceName?: string | null;
    /** A feed row's hash, stored so the next feed run can tell it unchanged. */
    feedRowHash?: string;
  }): Promise<ProductSourceRecord | undefined> {
    const { model, source: newSource, scrapedProduct } = params;
    // Trimmed/trailing-slash-stripped once here so every ProductSourceRecord.url
    // stored is already normalized.
    const sourceUrl = params.sourceUrl ? normalizeUrl(params.sourceUrl) : undefined;
    // Label used only for metrics/logging — admin-entered specs have no
    // ProductSource (source: null), everything else is scraped.
    const sourceLabel = newSource?.name ?? 'manual';
    if (newSource && !params.externalId) {
      throw new Error(
        `A listing of ${newSource.name} was written without the externalId its record is keyed by`,
      );
    }

    // Ensure sources loaded
    model.sources = model.sources ?? [];

    // Find THIS source's existing entry by the listing's key, or create a new
    // one. The admin's record has neither a key nor a URL.
    //
    // The source filter is load-bearing, not defensive. `model.sources` is
    // loaded across every source (see ProductScrapeUpdaterService.
    // getProductRelations), and two sources of one webshop can carry the same
    // id — so an id-only match can return the OTHER source's row. Everything
    // below then overwrites its scrapedProduct, both spec hashes and
    // specValid, while `source.source` is assigned on create only (further
    // down), so the row stays attributed to the source whose data was just
    // destroyed.
    let source = newSource
      ? model.sources.find(
          (s) => s.source?.id === newSource.id && s.externalId === params.externalId,
        )
      : model.sources.find((s) => !s.source && !s.url);
    // Found under another URL: the shop renamed the listing.
    if (source && sourceUrl) this.moveUrl(source, sourceUrl, sourceLabel);

    // `scrapedProduct.specs` is absent (whether `scrapedProduct` itself is
    // undefined, e.g. a manual edit with no re-scrape, or defined without
    // `specs`, e.g. ProductDetailsPageScraperService.extractProduct's
    // offerSpecsHash/productSpecsHash-both-unchanged branch) when the caller
    // determined there is nothing new to re-extract. Report the existing row
    // as-is rather than overwriting its specs with `{}`.
    if (scrapedProduct?.specs === undefined && source) {
      this.markSeen(source);
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

    // The admin's record also holds the admin's description: a manual-specs
    // save merges into it instead of replacing it.
    const written =
      !newSource && scrapedProduct
        ? { ...source.scrapedProduct, ...scrapedProduct }
        : scrapedProduct;
    this.writeListing(source, {
      ...params,
      scrapedProduct: written,
      sourceUrl,
      processedSpecs,
      validation,
    });

    this.logger.debug(
      `Upserted source record for product model ${model.id ?? model.displayName} (${sourceLabel}). Valid: ${validation.isValid}`,
    );

    return source;
  }

  /**
   * A listing of a source that does not identify products, whose offer its
   * seller does not have yet: written as any listing is, with no product, so
   * it attaches as it is once that offer exists. `existing` is this source's
   * record of the listing, found by its externalId. The caller saves it.
   */
  public upsertUnattached(params: {
    existing: ProductSourceRecord | null;
    source: ProductSource;
    scrapedProduct: ScrapedProduct;
    externalId?: string;
    sourceUrl: string;
    normalizedSourceName?: string | null;
    feedRowHash?: string;
  }): ProductSourceRecord {
    const record = params.existing ?? new ProductSourceRecord();
    if (params.existing) this.moveUrl(record, params.sourceUrl, params.source.name);
    record.model = null;
    record.source = params.source;

    const categorySlug = params.scrapedProduct.category?.slug;
    const processedSpecs = this.processSpecs(params.scrapedProduct.specs ?? {});
    const validation = this.validatorService.validateSpecs(
      categorySlug ? this.categoryConfigService.getJsonSchema(categorySlug) : undefined,
      processedSpecs,
    );
    this.writeListing(record, {
      ...params,
      sourceUrl: normalizeUrl(params.sourceUrl),
      processedSpecs,
      validation,
    });
    return record;
  }

  /**
   * Moves a listing's record to the URL the shop now shows it under: its own
   * URL, and that of its offer entries which pointed at the old page, so the
   * offer links to the live one. Each entry's offer id is pinned first: an
   * entry stored before resolvedExternalId existed derives it from the
   * record's URL, and must keep the id its offer is stored under.
   *
   * Nothing happens when the URL is the same. The caller saves the record.
   */
  public moveUrl(record: ProductSourceRecord, url: string, sourceName: string): void {
    const from = record.url;
    const to = normalizeUrl(url);
    if (!from || from === to) return;

    if (record.scrapedProduct?.offers) {
      record.scrapedProduct = {
        ...record.scrapedProduct,
        offers: record.scrapedProduct.offers.map((entry) => {
          const moved: ScrapedOffer =
            entry.resolvedExternalId === undefined
              ? { ...entry, resolvedExternalId: storedOfferExternalId(record, entry) ?? null }
              : { ...entry };
          if (entry.url && normalizeUrl(entry.url) === from) moved.url = to;
          return moved;
        }),
      };
    }
    record.url = to;

    this.productMetrics.sourceRecordUrlChanged(sourceName);
    this.logger.log('Listing URL changed', {
      recordId: record.id,
      source: sourceName,
      externalId: record.externalId,
      from,
      to,
    });
  }

  /** Everything a listing's record keeps of one import of it. */
  private writeListing(
    source: ProductSourceRecord,
    params: {
      scrapedProduct?: Partial<ScrapedProduct>;
      externalId?: string;
      sourceUrl?: string;
      normalizedSourceName?: string | null;
      feedRowHash?: string;
      processedSpecs: NonNullable<ScrapedProduct['specs']>;
      validation: ReturnType<ProductSpecValidatorService['validateSpecs']>;
    },
  ): void {
    const {
      scrapedProduct,
      externalId,
      sourceUrl,
      normalizedSourceName,
      processedSpecs,
      validation,
    } = params;
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
    this.markSeen(source);
    // Null clears it (a source that does not identify products keeps none);
    // undefined leaves it as stored.
    if (normalizedSourceName !== undefined)
      source.normalizedSourceName = normalizedSourceName;
    if (params.feedRowHash !== undefined) source.feedRowHash = params.feedRowHash;
  }

  /**
   * A source's listing was just imported, so the source still lists it — what
   * lets its values keep overwriting the seller's lower-priority sources. The
   * admin's record is no sighting of anything.
   */
  private markSeen(record: ProductSourceRecord): void {
    if (record.source) record.lastSeenAt = new Date();
  }

  private processSpecs(
    specs: NonNullable<ScrapedProduct['specs']>,
  ): NonNullable<ScrapedProduct['specs']> {
    return filterDefinedSpecs(specs);
  }
}
