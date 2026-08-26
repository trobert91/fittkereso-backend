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
import { hashRawSpecs, normalizeUrl } from '@fittkereso-backend/utils';
import {
  DeterministicProductData,
  MergedProductData,
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

    const rawSpecsHash = hashRawSpecs(detail.rawSpecs);

    // Skip re-extraction (deterministic mapping + optional LLM post-process)
    // when this exact listing was already scraped with an identical raw spec
    // table. `specs`/`rawSpecs` stay undefined on the returned ScrapedProduct
    // in that case — ProductSpecUpdaterService leaves the existing
    // ProductSourceRecord row's specs/rawSpecs untouched when both are absent.
    // The model name is also reused from the already-persisted ProductModel
    // rather than re-derived from the raw title, so a skipped re-scrape never
    // needs an LLM call either.
    const offerLevelKeys =
      this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs ??
      [];

    const existingSource = await this.findExistingSource(task, detail.externalId);
    if (!task.force && existingSource?.rawSpecsHash === rawSpecsHash) {
      const model = existingSource.model?.model ?? detail.model;
      this.logger.debug('Raw specs unchanged since last scrape, skipping extraction', {
        taskId: task.id,
        url: task.url,
        externalId: detail.externalId,
      });
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'raw_specs_unchanged',
      );
      // No fresh specs extracted this pass (rawSpecsHash unchanged), so
      // offer-level keys (e.g. frameSize) must come from somewhere other
      // than existingSource.scrapedProduct.specs — that field structurally
      // never carries them (they're omit()'d before being persisted there;
      // see the non-fast-path branch below, pageOfferLevelSpecs/
      // strippedSpecs). The only place they still live across scrapes is
      // the previously-persisted Offer row(s) on this same record, so read
      // them back from there instead — otherwise every re-scrape that hits
      // this skip path would overwrite each offer's specs with {}, silently
      // wiping out frameSize/color on every subsequent scrape after the
      // first.
      const existingOfferForSpecs =
        existingSource.offers?.find((o) => o.externalId === detail.externalId) ??
        existingSource.offers?.[0];
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
          releaseYear: detail.releaseYear,
          externalId: detail.externalId,
          imageUrls: detail.imageUrls,
          offers: this.toScrapedOffers(detail.rawOffers, existingPageOfferLevelSpecs),
        },
        offerLevelSpecs: existingPageOfferLevelSpecs,
        offerLinks: detail.offerLinks,
      };
    }

    const sourceConfig = config.detailPage.specMapping[category.slug];
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

    const deterministicData: DeterministicProductData = {
      brand: detail.brand,
      model: detail.model,
      specs: deterministicSpecs,
      releaseYear: detail.releaseYear,
    };

    const { brand, model, specs, releaseYear } = await this.maybePostProcess({
      task,
      data: deterministicData,
      rawSpecs: detail.rawSpecs,
      jsonSchema,
      categorySlug: category.slug,
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
        rawSpecs: detail.rawSpecs,
        externalId: detail.externalId,
        aliases: detail.aliases,
        releaseYear,
        imageUrls: detail.imageUrls,
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
    rawSpecs: ScrapedProductSpec[];
    jsonSchema: SpecDefinitionJsonSchema;
    categorySlug: string;
  }): Promise<MergedProductData> {
    const { task, data, rawSpecs, jsonSchema, categorySlug } = params;
    const postProcessConfig = task.source.config.detailPage.postProcess;

    if (postProcessConfig?.enabled === false) {
      return this.postProcessMerge.merge(data, undefined);
    }

    const goldenSample = this.categoryConfigService.getGoldenSample(categorySlug);
    if (!goldenSample) {
      this.logger.warn(
        `Post-processing enabled for source '${task.source.name}' but category '${categorySlug}' has no golden sample, skipping`,
        { taskId: task.id, url: task.url },
      );
      return this.postProcessMerge.merge(data, undefined);
    }

    const offerLevelSpecs =
      this.categoryConfigService.getConfig(categorySlug)?.offerLevelSpecs;

    const llmContribution = await this.postProcess.process({
      data,
      rawSpecs,
      schema: jsonSchema,
      goldenSample,
      model: postProcessConfig?.model,
      thinking: postProcessConfig?.thinking,
      effort: postProcessConfig?.effort,
      maxTokens: postProcessConfig?.maxTokens,
      offerLevelSpecs,
    });

    return this.postProcessMerge.merge(data, llmContribution);
  }

  // RawOfferRecord's fields are all optional (interpreter output before
  // validation); ScrapedOffer requires sellerName/price, so entries missing
  // either are dropped here rather than persisted as broken Offer rows.
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
        (offer): offer is RawOfferRecord & { sellerName: string; price: number } =>
          !!offer.sellerName && typeof offer.price === 'number' && Number.isFinite(offer.price),
      )
      .map((offer) => ({
        sellerName: offer.sellerName,
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
