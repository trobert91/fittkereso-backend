import {
  OfferAvailability,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductSpecs,
  ScrapeQueueName,
  ScrapeTask,
  SourceSpecConfig,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import * as cheerio from 'cheerio';
import { Injectable } from '@nestjs/common';
import { ProductScrapeUpdaterService } from './product-scrape-updater.service';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { filterDefinedSpecs, hashSpecs, normalizeUrl } from '@fittkereso-backend/utils';
import {
  DeterministicProductData,
  MergedProductData,
  ModelSpecContribution,
  OfferIdentityContribution,
  ProductSourceImage,
  ProductSourcePostProcessMergeService,
  ProductSourcePostProcessService,
  ScrapedOffer,
  ScrapedProduct,
  ScrapedProductSpec,
  SpecExtractionService,
  SpecTranslationSelectorService,
} from '@fittkereso-backend/product';
import {
  DetailPageResult,
  RawOfferRecord,
} from '@fittkereso-backend/scrape-interpreter';
import { TranslationService } from '@fittkereso-backend/translation';
import {
  RuntimeDataProviderService,
  ScrapeInterpreterService,
} from '@fittkereso-backend/scrape-interpreter';
import { omit, pick, uniqBy } from 'lodash';
import ms from 'ms';

interface ExtractedPage {
  scrapedProduct: ScrapedProduct;
  offerLevelSpecs: ProductSpecs;
  offerLinks: DetailPageResult['offerLinks'];
}

// Guards the cross-sibling productSpecsHash lookup against two unrelated
// listings on the same source coincidentally sharing a sparse/near-empty
// (or fully empty) product-level deterministic specs object and wrongly
// sharing product-identity specs.
const MIN_PRODUCT_SPEC_KEYS_FOR_SIBLING_REUSE = 3;

@Injectable()
export class ProductDetailsPageScraperService {
  private readonly logger = new CustomLogger(
    ProductDetailsPageScraperService.name,
  );

  constructor(
    private readonly scraperService: ScraperService,
    private readonly productUpdaterService: ProductScrapeUpdaterService,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly runtime: RuntimeDataProviderService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly specExtraction: SpecExtractionService,
    private readonly postProcess: ProductSourcePostProcessService,
    private readonly postProcessMerge: ProductSourcePostProcessMergeService,
    private readonly translationSelector: SpecTranslationSelectorService,
    private readonly translationService: TranslationService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
  ) {}

  public async scrapeProductDetailsPage(task: ScrapeTask): Promise<void> {
    const sourceName = task.source.name;
    const startTime = Date.now();

    this.logger.debug('Scraping product detail page', {
      taskId: task.id,
      url: task.url,
      sourceName,
    });

    try {
      const primaryUrl = normalizeUrl(task.url);
      const html = await this.scraperService.getHtml(primaryUrl);
      const $ = cheerio.load(html);

      const extractionStart = Date.now();
      const extracted = await this.extractProduct(task, $);
      this.scrapingMetrics.recordExtractionDuration(
        sourceName,
        (Date.now() - extractionStart) / 1000,
      );

      if (!extracted) {
        this.logger.debug('Product extraction skipped', {
          taskId: task.id,
          url: task.url,
          sourceName,
        });
        this.scrapingMetrics.recordExtractionOutcome(sourceName, 'skipped');
        return;
      }

      await this.dispatchVariantTasks(task, extracted);
      const { scrapedProduct } = extracted;

      const result = await this.productUpdaterService.createOrUpdateProduct(
        task,
        scrapedProduct,
      );

      if (result) {
        this.logger.debug('Product scrape succeeded', {
          taskId: task.id,
          url: task.url,
          sourceName,
          brand: scrapedProduct.brand,
          model: scrapedProduct.model,
          categorySlug: scrapedProduct.category.slug,
          offersFound: scrapedProduct.offers?.length ?? 0,
        });
        this.scrapingMetrics.recordExtractionOutcome(sourceName, 'success');
      } else {
        this.logger.warn('Product scrape skipped — brand resolution failed', {
          taskId: task.id,
          url: task.url,
          sourceName,
        });
        this.scrapingMetrics.recordExtractionOutcome(
          sourceName,
          'skipped_brand_failed',
        );
      }
    } catch (error) {
      this.logger.error('Product detail scrape failed', error, {
        taskId: task.id,
        url: task.url,
        sourceName,
      });
      this.scrapingMetrics.recordExtractionOutcome(sourceName, 'error');
      throw error;
    } finally {
      this.scrapingMetrics.recordScrapeDuration(
        sourceName,
        (Date.now() - startTime) / 1000,
      );
    }
  }

  // Cross-page variant-link following. Rather than fetching every sibling
  // variant page inline within this task (the old behavior), each distinct
  // variant URL is dispatched as its own independently scheduled
  // ScrapeTask — it gets picked up, scraped, and resolved back to this same
  // product on its own schedule, going through the normal pipeline's
  // scheduling/concurrency/retry/metrics machinery instead of bypassing it.
  // Multiple `offerLinks` entries pointing at the same URL (e.g. several
  // offer anchors on the page linking to one shared variant page) count as
  // one variant, not several — dedup by normalized URL before dispatching.
  private async dispatchVariantTasks(
    task: ScrapeTask,
    primary: ExtractedPage,
  ): Promise<void> {
    if (primary.offerLinks.length === 0) {
      return;
    }

    const distinctLinks = uniqBy(primary.offerLinks, (link) =>
      normalizeUrl(link.url),
    );
    const processedSince = new Date(
      Date.now() - ms(task.source.fullSyncInterval ?? '7 days'),
    );

    for (const link of distinctLinks) {
      const variantUrl = normalizeUrl(link.url);
      try {
        const outcome = await this.scrapeTaskPublisher.dispatchIfNeeded({
          url: variantUrl,
          source: task.source,
          queue: ScrapeQueueName.ScrapeProductDetails,
          processedSince,
        });
        let reason: string | undefined;
        if (outcome.dispatched === false) {
          reason = outcome.reason;
        }
        this.logger.debug('Variant task dispatch outcome', {
          taskId: task.id,
          primaryUrl: task.url,
          variantUrl,
          dispatched: outcome.dispatched,
          reason,
        });
      } catch (error) {
        this.logger.warn('Failed to dispatch variant task, skipping', {
          taskId: task.id,
          primaryUrl: task.url,
          variantUrl,
          error,
        });
      }
    }
  }

  private async extractProduct(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<ExtractedPage | null> {
    const config = task.source.config;
    const detail = await this.interpreter.runDetailPage(task, $, config);

    if (!detail.categorySlug) {
      this.logger.warn(
        'Category could not be identified, skipping product creation',
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'category_not_identified',
      );
      throw new Error('Category could not be identified');
    }

    const categoryEnabled =
      config.categories?.[detail.categorySlug]?.enabled ?? false;
    if (!categoryEnabled) {
      this.logger.debug(
        `Skipping product — category '${detail.categorySlug}' not enabled for ${task.source.name}`,
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'category_not_enabled',
      );
      return null;
    }

    const category = await this.runtime.getCategoryBySlug(detail.categorySlug);
    if (!category) {
      this.logger.warn('Category slug not found in database', {
        taskId: task.id,
        url: task.url,
        categorySlug: detail.categorySlug,
      });
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'category_not_identified',
      );
      throw new Error('Category could not be identified');
    }

    const jsonSchema = this.categoryConfigService.getJsonSchema(category.slug);
    if (!jsonSchema) {
      this.logger.warn(
        'Category has no associated JSON schema, skipping product creation',
        { taskId: task.id, url: task.url, categorySlug: category.slug },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'missing_schema',
      );
      throw new Error('Category has no associated JSON schema');
    }

    // `detail.model` is only required to be present, not already clean — some
    // sources (e.g. speedbike.hu) only expose the full marketing title as
    // their "model" field; maybePostProcess below cleans it via the LLM when
    // configured. Brand stays a hard requirement: every source's brand field
    // observed so far is a clean, reliable value, unlike model/title.
    if (!detail.brand || !detail.model) {
      this.logger.warn(
        'Skipping product — missing required brand or model',
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'missing_brand_or_model',
      );
      return null;
    }

    const offerLevelKeys =
      this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs ??
      [];
    const sourceConfig = config.detailPage.specMapping[category.slug];

    // Deterministic mapping runs unconditionally and unconditionally cheap
    // (no LLM) — its output is the canonical object both hashes and both
    // post-process calls are built from, split once by offerLevelKeys.
    const translator = await this.buildTranslator(
      task,
      detail.rawSpecs,
      sourceConfig,
      category.name,
    );
    const deterministicSpecs = sourceConfig
      ? this.specExtraction.extractSpecs({
          scrapedSpecs: detail.rawSpecs,
          schema: jsonSchema,
          sourceConfig,
          translator,
        })
      : {};
    // detailPage.releaseYear is a dedicated deterministic scrape-op some
    // sources use when the release/model year isn't part of the labeled spec
    // table — folded into the same modelYear key the label-based mapping
    // would otherwise populate, so downstream code has exactly one place to
    // look regardless of which extraction path produced it.
    if (deterministicSpecs['modelYear'] === undefined && detail.releaseYear !== undefined) {
      deterministicSpecs['modelYear'] = detail.releaseYear;
    }
    // Filtered once, here, via filterDefinedSpecs — dropping keys a
    // normalization pass mapped but couldn't type-convert (e.g.
    // ProductSpecNormalizationService assigning `undefined` for a value that
    // doesn't fit the schema's declared type) — so hashing, the LLM calls'
    // input, and persistence (ProductSourceRecordUpdaterService) all agree on
    // exactly the same object instead of each deriving a slightly different
    // "cleaned" view of it. Without this, a phantom undefined-valued key
    // present only at hash time made two byte-identical specs objects hash
    // differently depending on when in the pipeline they were hashed.
    const offerLevelDeterministicSpecs = filterDefinedSpecs(
      pick(deterministicSpecs, offerLevelKeys),
    );
    const productLevelDeterministicSpecs = filterDefinedSpecs(
      omit(deterministicSpecs, offerLevelKeys),
    );

    // Two independent hashes, one per post-process call's own input,
    // computed once here from the already-split, already-filtered canonical
    // objects above (not raw scraped rows) — see hashSpecs. Disjoint by
    // construction, so an offer-level-only difference between sibling
    // variant pages (e.g. a different frameSize) never invalidates the
    // (expensive, shared) product-identity half. Passed through on
    // ScrapedProduct (below) rather than recomputed later — see
    // ProductSourceRecordUpdaterService.upsertSourceRecord, which persists
    // these values as given instead of hashing again.
    const offerSpecsHash = hashSpecs(offerLevelDeterministicSpecs);
    const productSpecsHash = hashSpecs(productLevelDeterministicSpecs);

    const existingSource = await this.findExistingSource(task, detail.externalId);

    // No fresh specs extracted for whichever half is unchanged, so
    // offer-level keys (e.g. frameSize) must come from somewhere other than
    // existingSource.scrapedProduct.specs — that field structurally never
    // carries them (they're omit()'d before being persisted there; see
    // pageOfferLevelSpecs/strippedSpecs below). The only place they still
    // live across scrapes is the previously-persisted Offer row(s) on this
    // same record, so read them back from there instead — otherwise a
    // re-scrape hitting the offer-identity skip would overwrite each offer's
    // specs with {}, silently wiping out frameSize/color on every subsequent
    // scrape after the first.
    const existingOfferForSpecs =
      existingSource?.offers?.find((o) => o.externalId === detail.externalId) ??
      existingSource?.offers?.[0];

    const offerIdentitySameRecordHit =
      !task.force && existingSource?.offerSpecsHash === offerSpecsHash;
    const productSpecsSameRecordHit =
      !task.force && existingSource?.productSpecsHash === productSpecsHash;

    if (offerIdentitySameRecordHit) {
      this.logger.debug(
        'Offer specs unchanged since last scrape, skipping offer-identity call',
        { taskId: task.id, url: task.url, externalId: detail.externalId, offerSpecsHash },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'offer_specs_unchanged',
      );
    }
    if (productSpecsSameRecordHit) {
      this.logger.debug(
        'Product specs unchanged since last scrape, skipping model-spec call',
        { taskId: task.id, url: task.url, externalId: detail.externalId, productSpecsHash },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'product_specs_unchanged',
      );
    }

    // Both halves unchanged — full skip, same shape as the old single-hash
    // fast path: no fresh LLM work at all, reuse the persisted model name
    // and this record's own offer-level specs.
    if (offerIdentitySameRecordHit && productSpecsSameRecordHit) {
      const model = existingSource!.model?.model ?? detail.model;
      const existingPageOfferLevelSpecs = pick(
        existingOfferForSpecs?.specs,
        offerLevelKeys,
      );
      return {
        scrapedProduct: {
          brand: detail.brand,
          model,
          displayName: `${detail.brand} ${model}`.trim(),
          originalName: detail.model,
          category,
          aliases: detail.aliases,
          externalId: detail.externalId,
          images: this.toScrapedImages(detail.imageUrls),
          offers: this.toScrapedOffers(detail.rawOffers, existingPageOfferLevelSpecs),
        },
        offerLevelSpecs: existingPageOfferLevelSpecs,
        offerLinks: detail.offerLinks,
      };
    }

    const deterministicData: DeterministicProductData = {
      brand: detail.brand,
      model: detail.model,
      specs: deterministicSpecs,
    };

    const { brand, model, specs } = await this.maybePostProcess({
      task,
      data: deterministicData,
      offerLevelDeterministicSpecs,
      productLevelDeterministicSpecs,
      rawSpecs: detail.rawSpecs,
      description: detail.description,
      productSpecsHash,
      jsonSchema,
      categorySlug: category.slug,
      offerIdentitySameRecordHit,
      existingSource: existingSource ?? undefined,
      existingOfferForSpecs,
      offerLevelKeys,
    });

    // Offer-level keys (e.g. frameSize) never reach the shared
    // ProductModel/ProductSourceRecord.specs — they vary between the very
    // offers a single ProductModel groups together, so they have no single
    // correct value at the model level. The pre-strip value is what each
    // offer's own specs is picked from instead — see toScrapedOffers below.
    const pageOfferLevelSpecs = pick(specs, offerLevelKeys);
    const strippedSpecs = omit(specs, offerLevelKeys);

    return {
      scrapedProduct: {
        brand,
        model,
        displayName: `${brand} ${model}`.trim(),
        originalName: detail.model,
        category,
        specs: strippedSpecs,
        extractedSpecs: deterministicSpecs,
        offerLevelDeterministicSpecs,
        productLevelDeterministicSpecs,
        offerSpecsHash,
        productSpecsHash,
        rawSpecs: detail.rawSpecs,
        description: detail.description,
        externalId: detail.externalId,
        aliases: detail.aliases,
        images: this.toScrapedImages(detail.imageUrls),
        offers: this.toScrapedOffers(detail.rawOffers, pageOfferLevelSpecs),
      },
      offerLevelSpecs: pageOfferLevelSpecs,
      offerLinks: detail.offerLinks,
    };
  }

  /**
   * Identity lookup ahead of full resolution — prefers the source-native
   * externalId (stable across URL changes) via a dedicated repository query;
   * falls back to a URL lookup when the source has no externalId pipeline
   * configured. `ScrapeTask.product` is loaded without its `sources`
   * relation at this point (see ScrapeTaskRepository), so this always does a
   * fresh lookup rather than relying on task.product.sources being populated.
   */
  private async findExistingSource(
    task: ScrapeTask,
    externalId: string | undefined,
  ): Promise<ProductSourceRecord | null> {
    if (externalId) {
      return this.sourceRecordRepo.findBySourceAndExternalId(
        task.source.id,
        externalId,
      );
    }
    return this.sourceRecordRepo.findByUrl(normalizeUrl(task.url));
  }

  private async maybePostProcess(params: {
    task: ScrapeTask;
    data: DeterministicProductData;
    offerLevelDeterministicSpecs: ProductSpecs;
    productLevelDeterministicSpecs: ProductSpecs;
    rawSpecs: ScrapedProductSpec[];
    description?: string;
    productSpecsHash: string;
    jsonSchema: SpecDefinitionJsonSchema;
    categorySlug: string;
    offerIdentitySameRecordHit: boolean;
    existingSource: ProductSourceRecord | undefined;
    existingOfferForSpecs: { specs?: ProductSpecs } | undefined;
    offerLevelKeys: string[];
  }): Promise<MergedProductData> {
    const {
      task,
      data,
      offerLevelDeterministicSpecs,
      productLevelDeterministicSpecs,
      rawSpecs,
      description,
      productSpecsHash,
      jsonSchema,
      categorySlug,
      offerIdentitySameRecordHit,
      existingSource,
      existingOfferForSpecs,
      offerLevelKeys,
    } = params;
    const postProcessConfig = task.source.config.detailPage.postProcess;

    if (postProcessConfig?.enabled === false) {
      return this.postProcessMerge.merge(data, undefined, undefined);
    }

    const goldenSample = this.categoryConfigService.getGoldenSample(categorySlug);
    if (!goldenSample) {
      this.logger.warn(
        `Post-processing enabled for source '${task.source.name}' but category '${categorySlug}' has no golden sample, skipping`,
        { taskId: task.id, url: task.url },
      );
      return this.postProcessMerge.merge(data, undefined, undefined);
    }

    const llmOptions = {
      model: postProcessConfig?.model,
      thinking: postProcessConfig?.thinking,
      effort: postProcessConfig?.effort,
      maxTokens: postProcessConfig?.maxTokens,
    };

    const offerIdentity = await this.getOfferIdentity({
      task,
      data,
      offerLevelDeterministicSpecs,
      description: postProcessConfig?.includeDescriptionInOfferIdentity
        ? description
        : undefined,
      schema: jsonSchema,
      goldenSample,
      offerLevelSpecs: offerLevelKeys,
      sameRecordHit: offerIdentitySameRecordHit,
      existingOfferForSpecs,
      llmOptions,
    });

    const modelSpecs = await this.getModelSpecs({
      task,
      data,
      productLevelDeterministicSpecs,
      rawSpecs,
      description:
        postProcessConfig?.includeDescriptionInModelSpecs === false
          ? undefined
          : description,
      productSpecsHash,
      schema: jsonSchema,
      goldenSample,
      offerLevelSpecs: offerLevelKeys,
      existingSource,
      llmOptions,
    });

    return this.postProcessMerge.merge(data, offerIdentity, modelSpecs);
  }

  // Always resolves to *something* usable — either a same-record reuse (no
  // LLM call) or a fresh processOfferIdentity call. This half's output is
  // inherently page-specific (a listing's own title/size/color) and is never
  // looked up from a sibling the way getModelSpecs's product-identity half
  // is; the only reuse this half supports is the same listing re-scraped
  // unchanged. No raw spec rows are sent to this call at all — its input is
  // just the raw title/model text plus offerLevelDeterministicSpecs, the
  // already-mapped offer-level subset of the deterministic pass.
  private async getOfferIdentity(params: {
    task: ScrapeTask;
    data: DeterministicProductData;
    offerLevelDeterministicSpecs: ProductSpecs;
    description?: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    sameRecordHit: boolean;
    existingOfferForSpecs: { specs?: ProductSpecs } | undefined;
    llmOptions: {
      model?: string;
      thinking?: boolean;
      effort?: string;
      maxTokens?: number;
    };
  }): Promise<OfferIdentityContribution | undefined> {
    const {
      task,
      data,
      offerLevelDeterministicSpecs,
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
      sameRecordHit,
      existingOfferForSpecs,
      llmOptions,
    } = params;

    if (sameRecordHit) {
      // No fresh offer-identity contribution this pass — the persisted
      // listing's own offer-level specs (recovered from its Offer row, since
      // they're stripped before landing on scrapedProduct.specs) are the
      // closest equivalent to "what processOfferIdentity would have said."
      return { specs: pick(existingOfferForSpecs?.specs, offerLevelSpecs) };
    }

    this.logger.debug('Running offer-identity LLM call', {
      taskId: task.id,
      url: task.url,
      offerLevelKeyCount: Object.keys(offerLevelDeterministicSpecs).length,
    });

    return this.postProcess.processOfferIdentity({
      data: {
        brand: data.brand,
        model: data.model,
        specs: offerLevelDeterministicSpecs,
      },
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
      ...llmOptions,
    });
  }

  // The expensive, reasoning-heavy half. Checks (in order): same-record hash
  // match (data already in hand from extractProduct, no extra query), then a
  // cross-sibling productSpecsHash match (a different ProductSourceRecord on
  // the same source whose product-identity deterministic specs were
  // identical), and only calls the LLM when both miss.
  private async getModelSpecs(params: {
    task: ScrapeTask;
    data: DeterministicProductData;
    productLevelDeterministicSpecs: ProductSpecs;
    rawSpecs: ScrapedProductSpec[];
    description?: string;
    productSpecsHash: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    existingSource: ProductSourceRecord | undefined;
    llmOptions: {
      model?: string;
      thinking?: boolean;
      effort?: string;
      maxTokens?: number;
    };
  }): Promise<ModelSpecContribution | undefined> {
    const {
      task,
      data,
      productLevelDeterministicSpecs,
      rawSpecs,
      description,
      productSpecsHash,
      schema,
      goldenSample,
      offerLevelSpecs,
      existingSource,
      llmOptions,
    } = params;

    if (existingSource?.productSpecsHash === productSpecsHash && !task.force) {
      // Same-record hit — already logged/metered by the caller
      // (extractProduct), which computed this comparison first. Reuse this
      // record's own already-persisted product-identity specs.
      return { specs: existingSource.scrapedProduct?.productLevelDeterministicSpecs ?? {} };
    }

    if (
      !task.force &&
      Object.keys(productLevelDeterministicSpecs).length >=
        MIN_PRODUCT_SPEC_KEYS_FOR_SIBLING_REUSE
    ) {
      const sibling = await this.sourceRecordRepo.findBySourceAndProductSpecsHash(
        task.source.id,
        productSpecsHash,
      );
      if (sibling?.scrapedProduct?.productLevelDeterministicSpecs !== undefined) {
        this.logger.debug(
          'Product specs match a sibling source record, reusing its unified model-level specs',
          {
            taskId: task.id,
            url: task.url,
            productSpecsHash,
            siblingSourceId: sibling.id,
            siblingUrl: sibling.url,
            siblingLastUpdated: sibling.lastUpdated,
          },
        );
        this.scrapingMetrics.recordExtractionSkipReason(
          task.source.name,
          'product_specs_matched_sibling',
        );
        return { specs: sibling.scrapedProduct.productLevelDeterministicSpecs };
      }
    }

    this.logger.debug('Running model-spec LLM call', {
      taskId: task.id,
      url: task.url,
      productSpecsHash,
      productLevelKeyCount: Object.keys(productLevelDeterministicSpecs).length,
    });

    return this.postProcess.processModelSpecs({
      data: { ...data, specs: productLevelDeterministicSpecs },
      rawSpecs,
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
      ...llmOptions,
    });
  }

  // RawOfferRecord's fields are all optional (interpreter output before
  // validation); ScrapedOffer requires price, so entries missing it are
  // dropped here rather than persisted as broken Offer rows.
  // Each offer's own specs (from an assembleOffer op's per-item `specs`
  // sub-pipelines, e.g. frameSize varying per variant) take priority; the
  // page-level offerLevelSpecs is the fallback for offers with none of
  // their own — the ordinary single-offer-per-page case.
  private toScrapedOffers(
    rawOffers: RawOfferRecord[],
    pageOfferLevelSpecs: ProductSpecs,
  ): ScrapedOffer[] {
    return rawOffers
      .filter(
        (offer): offer is RawOfferRecord & { price: number } =>
          typeof offer.price === 'number' && Number.isFinite(offer.price),
      )
      .map((offer) => ({
        price: offer.price,
        priceWithoutDiscount: offer.priceWithoutDiscount,
        currency: offer.currency,
        availability: this.parseAvailability(offer.availability),
        url: offer.url ? normalizeUrl(offer.url) : offer.url,
        externalId: offer.externalId,
        locations: offer.locations,
        specs: offer.specs ?? pageOfferLevelSpecs,
      }));
  }

  // The interpreter pipeline only ever produces a flat, ordered string[]
  // (no per-image metadata) — array position is the only ordering signal a
  // source config can express, so it's what order is derived from here.
  private toScrapedImages(imageUrls: string[]): ProductSourceImage[] {
    return imageUrls.map((url, order) => ({ url, order }));
  }

  private parseAvailability(
    value: string | undefined,
  ): OfferAvailability | undefined {
    return value && (Object.values(OfferAvailability) as string[]).includes(value)
      ? (value as OfferAvailability)
      : undefined;
  }

  private async buildTranslator(
    task: ScrapeTask,
    rawSpecs: ScrapedProductSpec[],
    sourceConfig: SourceSpecConfig | undefined,
    categoryName: string,
  ) {
    const translationConfig = task.source.config.detailPage.translation;
    if (!translationConfig?.enabled) {
      return undefined;
    }

    const rawValues = this.translationSelector.collectTranslatableValues(
      rawSpecs,
      sourceConfig,
    );
    if (rawValues.length === 0) {
      return undefined;
    }

    const context = translationConfig.contextTemplate.replace(
      /\{\{\s*categoryName\s*\}\}/g,
      categoryName,
    );

    const { lookup, stats } = await this.translationService.translateBatch({
      texts: rawValues,
      sourceLanguage: translationConfig.sourceLanguage,
      targetLanguage: translationConfig.targetLanguage,
      context,
    });

    this.logger.debug('Spec translation completed', {
      url: task.url,
      ...stats,
    });

    return lookup;
  }
}
