import {
  ProductImportTaskKind,
  ProductImportTask,
  ScrapingSourceConfig,
  asScrapingConfig,
  isFeedSourceType,
} from '@fittkereso-backend/database';
import { Injectable } from '@nestjs/common';
import { ProductScrapeUpdaterService } from './product-scrape-updater.service';
import { contextFromTask } from '../../interfaces/product-import-context.interface';
import { ProductImportTaskPublisherService } from '@fittkereso-backend/task';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { normalizeUrl } from '@fittkereso-backend/utils';
import { ProductSourceImage, ScrapedProduct } from '@fittkereso-backend/product';
import {
  foldBrandIdentifierSpecs,
  foldReleaseYear,
  splitDeterministicSpecs,
} from './deterministic-specs';
import { toScrapedOffers } from './scraped-offers';
import { DetailPageResult } from '@fittkereso-backend/scrape-interpreter';
import { PageInterpretation, ProductPageReaderService } from './product-page-reader.service';
import { ArukeresoFeedEntryService } from '../../arukereso/arukereso-feed-entry.service';
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
    private readonly pageReader: ProductPageReaderService,
    private readonly productUpdaterService: ProductScrapeUpdaterService,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly importTaskPublisher: ProductImportTaskPublisherService,
    private readonly feedEntries: ArukeresoFeedEntryService,
  ) {}

  public async scrapeProductDetailsPage(task: ProductImportTask): Promise<void> {
    // A feed source's page task carries its feed rows: the page is read
    // once with the same reader, and fills what the rows lack.
    if (isFeedSourceType(task.source.type)) {
      await this.feedEntries.importEntry(task, { fetchPage: true });
      return;
    }

    const sourceName = task.source.name;
    const startTime = Date.now();

    this.logger.debug('Scraping product detail page', {
      taskId: task.id,
      url: task.url,
      sourceName,
    });

    try {
      // The page, read by the service a feed source reads its rows' pages
      // with too: fetched (detailPage.fetchMode, else the source's),
      // interpreted, and refused when it shows another product than the
      // card that queued the task (a delisted URL redirected elsewhere).
      const config = asScrapingConfig(task.source.config, task.source.name);
      const interpretation = await this.pageReader.interpret({
        task,
        config,
        expectedExternalIds: [task.externalId],
      });

      const extractionStart = Date.now();
      const extracted = await this.extractProduct(task, config, interpretation);
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
          title: scrapedProduct.originalName,
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
    config: ScrapingSourceConfig,
    interpretation: PageInterpretation,
  ): Promise<ExtractedPage | null> {
    const { detail, categoryProblem } = interpretation;

    if (categoryProblem?.reason === 'ambiguous') {
      this.logger.warn('Category is ambiguous, skipping product creation', {
        taskId: task.id,
        url: task.url,
        categorySlugs: categoryProblem.slugs,
      });
      this.scrapingMetrics.recordExtractionSkipReason(task.source.name, 'category_ambiguous');
      throw new Error(
        `Category is ambiguous: the rules of ${categoryProblem.slugs.join(', ')} all match`,
      );
    }

    if (categoryProblem?.reason === 'not_identified' && !categoryProblem.slug) {
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

    if (categoryProblem?.reason === 'not_enabled') {
      this.logger.debug(
        `Skipping product — category '${categoryProblem.slug}' not enabled for ${task.source.name}`,
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'category_not_enabled',
      );
      return null;
    }

    if (categoryProblem?.reason === 'not_identified') {
      this.logger.warn('Category slug not found in database', {
        taskId: task.id,
        url: task.url,
        categorySlug: categoryProblem.slug,
      });
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'category_not_identified',
      );
      throw new Error('Category could not be identified');
    }

    if (categoryProblem?.reason === 'no_schema') {
      this.logger.warn(
        'Category has no associated JSON schema, skipping product creation',
        { taskId: task.id, url: task.url, categorySlug: categoryProblem.slug },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        task.source.name,
        'missing_schema',
      );
      throw new Error('Category has no associated JSON schema');
    }

    const { category, schema: jsonSchema } = interpretation;
    if (!category || !jsonSchema) throw new Error('Category could not be identified');

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

    const categoryConfig = this.categoryConfigService.getConfig(category.slug);
    const offerLevelKeys = categoryConfig?.offerLevelSpecs ?? [];
    // Deterministic mapping runs unconditionally and unconditionally cheap
    // (no LLM) — its output is the canonical object both hashes and both
    // post-process calls are built from, split once by offerLevelKeys. Read
    // by the page reader, which a feed's page task maps rows with too.
    const deterministicSpecs = await this.pageReader.mapSpecs({ task, config, interpretation });
    foldReleaseYear(deterministicSpecs, detail.releaseYear);
    const offers = toScrapedOffers(detail.rawOffers);
    foldBrandIdentifierSpecs(
      deterministicSpecs,
      { brand: detail.brand, offers },
      categoryConfig?.brandIdentifierSpecs,
      jsonSchema,
    );
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
        // The page title is not a model name: the identity extraction reads
        // one off it, and until then the listing has only its title.
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
        offers,
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

}
