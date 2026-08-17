import {
  OfferAvailability,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapeTask,
  SourceSpecConfig,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import * as cheerio from 'cheerio';
import { Injectable } from '@nestjs/common';
import { ProductScrapeUpdaterService } from './product-scrape-updater.service';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { hashRawSpecs } from '@fittkereso-backend/utils';
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
import { RawOfferRecord } from '@fittkereso-backend/scrape-interpreter';
import { TranslationService } from '@fittkereso-backend/translation';
import {
  RuntimeDataProviderService,
  ScrapeInterpreterService,
} from '@fittkereso-backend/scrape-interpreter';

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
      const html = await this.scraperService.getHtml(task.url);
      const $ = cheerio.load(html);

      const extractionStart = Date.now();
      const scrapedProduct = await this.extractProduct(task, $);
      this.scrapingMetrics.recordExtractionDuration(
        sourceName,
        (Date.now() - extractionStart) / 1000,
      );

      if (!scrapedProduct) {
        this.logger.debug('Product extraction skipped', {
          taskId: task.id,
          url: task.url,
          sourceName,
        });
        this.scrapingMetrics.recordExtractionOutcome(sourceName, 'skipped');
        return;
      }

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

  private async extractProduct(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<ScrapedProduct | null> {
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
      return {
        brand: detail.brand,
        model,
        displayName: `${detail.brand} ${model}`.trim(),
        category,
        aliases: detail.aliases,
        releaseYear: detail.releaseYear,
        externalId: detail.externalId,
        imageUrls: detail.imageUrls,
        offers: this.toScrapedOffers(detail.rawOffers),
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

    return {
      brand,
      model,
      displayName: `${brand} ${model}`.trim(),
      category,
      specs,
      rawSpecs: detail.rawSpecs,
      externalId: detail.externalId,
      aliases: detail.aliases,
      releaseYear,
      imageUrls: detail.imageUrls,
      offers: this.toScrapedOffers(detail.rawOffers),
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
    return this.sourceRecordRepo.findByUrl(task.url);
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

    if (!postProcessConfig?.enabled) {
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

    const llmContribution = await this.postProcess.process({
      data,
      rawSpecs,
      schema: jsonSchema,
      goldenSample,
      model: postProcessConfig.model,
    });

    return this.postProcessMerge.merge(data, llmContribution);
  }

  // RawOfferRecord's fields are all optional (interpreter output before
  // validation); ScrapedOffer requires sellerName/price, so entries missing
  // either are dropped here rather than persisted as broken Offer rows.
  private toScrapedOffers(rawOffers: RawOfferRecord[]): ScrapedOffer[] {
    return rawOffers
      .filter(
        (offer): offer is RawOfferRecord & { sellerName: string; price: number } =>
          !!offer.sellerName && typeof offer.price === 'number' && Number.isFinite(offer.price),
      )
      .map((offer) => ({
        sellerName: offer.sellerName,
        price: offer.price,
        currency: offer.currency,
        availability: this.parseAvailability(offer.availability),
        url: offer.url,
        sourceListingId: offer.sourceListingId,
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
