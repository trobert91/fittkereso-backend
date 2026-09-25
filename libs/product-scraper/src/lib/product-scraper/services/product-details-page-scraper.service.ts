import {
  ProductImportTaskKind,
  ProductImportTask,
  SourceSpecConfig,
  asScrapingConfig,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import * as cheerio from 'cheerio';
import { Injectable } from '@nestjs/common';
import { ProductScrapeUpdaterService } from './product-scrape-updater.service';
import { contextFromTask } from '../../interfaces/product-import-context.interface';
import { ProductImportTaskPublisherService } from '@fittkereso-backend/task';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { normalizeUrl } from '@fittkereso-backend/utils';
import {
  ProductSourceImage,
  ScrapedProduct,
  ScrapedProductSpec,
  SpecExtractionService,
  SpecTranslationSelectorService,
} from '@fittkereso-backend/product';
import { splitDeterministicSpecs } from './deterministic-specs';
import { toScrapedOffers } from './scraped-offers';
import { DetailPageResult } from '@fittkereso-backend/scrape-interpreter';
import { TranslationService } from '@fittkereso-backend/translation';
import {
  RuntimeDataProviderService,
  ScrapeInterpreterService,
} from '@fittkereso-backend/scrape-interpreter';
import { uniqBy } from 'lodash';
import ms from 'ms';

interface ExtractedPage {
  scrapedProduct: ScrapedProduct;
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
    private readonly translationSelector: SpecTranslationSelectorService,
    private readonly translationService: TranslationService,
    private readonly importTaskPublisher: ProductImportTaskPublisherService,
  ) {}

  public async scrapeProductDetailsPage(task: ProductImportTask): Promise<void> {
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

      // contextFromTask, not the task itself: ProductImportTask structurally satisfies
      // ProductImportContext, so passing it directly compiles fine but leaves
      // context.task undefined — and the task writeback silently stops.
      const result = await this.productUpdaterService.createOrUpdateProduct(
        contextFromTask(task),
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
      } else if (task.source.identifiesProducts === false) {
        // Not a failure: a source that does not identify products stores a
        // listing whose offer its seller does not have yet without a product.
        this.logger.debug('Listing stored unattached — no offer of the seller to join yet', {
          taskId: task.id,
          url: task.url,
          sourceName,
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
  // ProductImportTask — it gets picked up, scraped, and resolved back to this same
  // product on its own schedule, going through the normal pipeline's
  // scheduling/concurrency/retry/metrics machinery instead of bypassing it.
  // Multiple `offerLinks` entries pointing at the same URL (e.g. several
  // offer anchors on the page linking to one shared variant page) count as
  // one variant, not several — dedup by normalized URL before dispatching.
  private async dispatchVariantTasks(
    task: ProductImportTask,
    primary: ExtractedPage,
  ): Promise<void> {
    if (primary.offerLinks.length === 0) {
      return;
    }

    const distinctLinks = uniqBy(primary.offerLinks, (link) =>
      normalizeUrl(link.url),
    );
    const processedSince = new Date(
      Date.now() - ms(task.source.frequency ?? '7 days'),
    );

    for (const link of distinctLinks) {
      const variantUrl = normalizeUrl(link.url);
      try {
        const outcome = await this.importTaskPublisher.dispatchIfNeeded({
          url: variantUrl,
          source: task.source,
          kind: ProductImportTaskKind.DetailPage,
          priority: task.priority,
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
    task: ProductImportTask,
    $: cheerio.CheerioAPI,
  ): Promise<ExtractedPage | null> {
    const config = asScrapingConfig(task.source.config, task.source.name);
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
    // their "model" field; the updater's identity extraction cleans it via
    // the LLM when configured. Brand stays a hard requirement: every source's brand field
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
    // Split and hashed by the shared helper, which every importer uses — see
    // splitDeterministicSpecs for why the filtering and the hashing have to
    // happen in exactly one place. The two hashes are passed through on
    // ScrapedProduct (below) rather than recomputed later; see
    // ProductSourceRecordUpdaterService.upsertSourceRecord, which persists
    // these values as given instead of hashing again.
    const {
      offerLevelDeterministicSpecs,
      productLevelDeterministicSpecs,
      offerSpecsHash,
      productSpecsHash,
    } = splitDeterministicSpecs(deterministicSpecs, offerLevelKeys);

    // Deterministic data only. Whether this listing needs an LLM call at all
    // depends on whether it was seen before, which only identity resolution
    // knows — so the updater makes that call (SpecPostProcessService), and
    // this importer never spends one.
    return {
      scrapedProduct: {
        brand: detail.brand,
        model: detail.model,
        displayName: `${detail.brand} ${detail.model}`.trim(),
        originalName: detail.model,
        category,
        specs: productLevelDeterministicSpecs,
        extractedSpecs: deterministicSpecs,
        offerLevelDeterministicSpecs,
        productLevelDeterministicSpecs,
        offerSpecsHash,
        productSpecsHash,
        rawSpecs: detail.rawSpecs,
        description: detail.description,
        externalId: detail.externalId,
        siblingExternalIds: detail.siblingIds,
        aliases: detail.aliases,
        images: this.toScrapedImages(detail.imageUrls),
        offers: toScrapedOffers(detail.rawOffers),
      },
      offerLinks: detail.offerLinks,
    };
  }

  // The interpreter pipeline only ever produces a flat, ordered string[]
  // (no per-image metadata) — array position is the only ordering signal a
  // source config can express, so it's what order is derived from here.
  private toScrapedImages(imageUrls: string[]): ProductSourceImage[] {
    return imageUrls.map((url, order) => ({ url, order }));
  }

  private async buildTranslator(
    task: ProductImportTask,
    rawSpecs: ScrapedProductSpec[],
    sourceConfig: SourceSpecConfig | undefined,
    categoryName: string,
  ) {
    const translationConfig = asScrapingConfig(
      task.source.config,
      task.source.name,
    ).detailPage.translation;
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
