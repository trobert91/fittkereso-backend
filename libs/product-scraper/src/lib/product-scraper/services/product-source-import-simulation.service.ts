import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  asArukeresoConfig,
  asScrapingConfig,
  OfferAvailability,
  ProductSource,
  ProductSourceRecordRepository,
  ProductSourceType,
  ScrapedListProduct,
  ScrapedProduct,
  ScrapeTask,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { NativeScraperService, ScraperService } from '@fittkereso-backend/scraper';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import { normalizeUrl } from '@fittkereso-backend/utils';
import { ScrapingImportService } from './scraping-import.service';
import { ListProductRefreshService } from './list-product-refresh.service';
import { ArukeresoFeedParserService } from '../../arukereso/arukereso-feed-parser.service';
import {
  ArukeresoProductMapperService,
  FeedSkipReason,
} from '../../arukereso/arukereso-product-mapper.service';

/** What a run would do with one list card, and why. */
export interface SimulatedListItemDecision {
  url: string;
  externalId?: string;
  price?: number;
  availability?: OfferAvailability;
  /** Whether THIS source already has a ProductSourceRecord for the URL. */
  known: boolean;
  satisfiesMinimumSet: boolean;
  /** Fields the minimum set asks for that this card does not carry. */
  missingFields: string[];
  wouldScrapeDetail: boolean;
  reason: string;
}

export interface SimulatedScrapingImport {
  startUrls: string[];
  categoryUrls: string[];
  /** Every page the run would enqueue, enumerated the way the importer does. */
  pageUrls: string[];
  listPageParsed: string;
  categoryName?: string;
  requiredFields: string[];
  decisions: SimulatedListItemDecision[];
  /** On this page: the split that says whether the minimum set is buying anything. */
  wouldRefreshInline: number;
  wouldScrapeDetail: number;
}

export interface SimulatedArukeresoImport {
  feedUrl: string;
  format: 'xml' | 'csv';
  itemsParsed: number;
  /** Attribute pairs dropped for missing a name or a value. */
  attributesSkipped: number;
  wouldImport: number;
  wouldSkip: number;
  skipReasons: Partial<Record<FeedSkipReason, number>>;
  /** Distinct externalIds among eligible items, and any that repeat. */
  distinctExternalIds: number;
  duplicateExternalIds: { externalId: string; count: number }[];
  itemsWithoutExternalId: number;
  /** Fully mapped previews — the only part that costs LLM calls. */
  products: ScrapedProduct[];
}

export interface ProductSourceImportSimulationResult {
  type: ProductSourceType;
  sourceName: string;
  scraping?: SimulatedScrapingImport;
  arukereso?: SimulatedArukeresoImport;
  warnings: string[];
  errors: string[];
}

/** Full previews are expensive; the counts around them are not. */
export const DEFAULT_PREVIEW_LIMIT = 5;

/**
 * Dry-run of a whole IMPORT RUN, as opposed to one detail page.
 *
 * ProductSourceSimulationService answers "what would this detail-page config
 * extract from this URL". This answers the question one level up, which is the
 * one a feed forces: what would tonight's run actually import, how much of the
 * catalogue survives the category gate, and — for a scraping source — how many
 * of the paid detail fetches the minimum set would avoid.
 *
 * Persists nothing: no tasks enqueued, no rows written. Where it can, it runs
 * the importers' own code (ScrapingImportService.planRun,
 * ArukeresoProductMapperService) rather than a reimplementation, because a
 * simulation of a reimplementation checks the wrong thing.
 */
@Injectable()
export class ProductSourceImportSimulationService {
  private readonly logger = new CustomLogger(
    ProductSourceImportSimulationService.name,
  );

  constructor(
    private readonly scraperService: ScraperService,
    private readonly nativeScraper: NativeScraperService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly scrapingImport: ScrapingImportService,
    private readonly listRefresh: ListProductRefreshService,
    private readonly feedParser: ArukeresoFeedParserService,
    private readonly mapper: ArukeresoProductMapperService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  public async simulate(
    source: ProductSource,
    options: { listUrl?: string; limit?: number; categorySlugs?: string[] } = {},
  ): Promise<ProductSourceImportSimulationResult> {
    const result: ProductSourceImportSimulationResult = {
      type: source.type,
      sourceName: source.name,
      warnings: [],
      errors: [],
    };

    try {
      if (source.type === 'arukereso') {
        result.arukereso = await this.simulateFeed(source, options, result);
      } else {
        result.scraping = await this.simulateScraping(source, options, result);
      }
    } catch (error: unknown) {
      result.errors.push(
        error instanceof Error ? error.message : String(error),
      );
    }

    return result;
  }

  // ─── scraping ──────────────────────────────────────────────────────────────

  private async simulateScraping(
    source: ProductSource,
    options: { listUrl?: string; limit?: number },
    result: ProductSourceImportSimulationResult,
  ): Promise<SimulatedScrapingImport> {
    const config = asScrapingConfig(source.config, source.name);

    const { categoryUrls, pageUrls } = await this.scrapingImport.planRun(
      source,
      config,
    );

    if (pageUrls.length === 0) {
      result.errors.push(
        'The run would enqueue no list pages at all — check startUrls and categoryLinks.',
      );
    }
    if (!config.listPage.pagination) {
      result.warnings.push(
        'No listPage.pagination configured, so only the first page of each listing is ever visited.',
      );
    }

    // One page is enough to judge the config; which one is the caller's choice
    // so a shop with an unusual first page can be checked on a typical one.
    const listPageParsed = options.listUrl ?? pageUrls[0] ?? '';
    if (!listPageParsed) {
      return {
        startUrls: config.startUrls ?? [],
        categoryUrls,
        pageUrls,
        listPageParsed: '',
        requiredFields: this.listRefresh.requiredFields,
        decisions: [],
        wouldRefreshInline: 0,
        wouldScrapeDetail: 0,
      };
    }

    const $ = cheerio.load(await this.scraperService.getHtml(listPageParsed));
    const page = await this.interpreter.runListPage(
      { id: 'simulate', url: listPageParsed, source } as ScrapeTask,
      $,
      config,
    );

    if (page.products.length === 0) {
      result.errors.push(
        `listPage.items/itemPipeline produced no cards from ${listPageParsed}.`,
      );
    }

    const limit = options.limit ?? DEFAULT_PREVIEW_LIMIT;
    const decisions: SimulatedListItemDecision[] = [];
    for (const item of page.products.slice(0, limit)) {
      decisions.push(await this.decide(source, item));
    }

    return {
      startUrls: config.startUrls ?? [],
      categoryUrls,
      pageUrls,
      listPageParsed,
      categoryName: page.categoryName,
      requiredFields: this.listRefresh.requiredFields,
      decisions,
      wouldRefreshInline: decisions.filter((d) => !d.wouldScrapeDetail).length,
      wouldScrapeDetail: decisions.filter((d) => d.wouldScrapeDetail).length,
    };
  }

  /**
   * The minimum-set decision for one card, made by the same service the real
   * run uses — minus the write.
   *
   * Reporting the reason per item is what makes the minimum set tunable against
   * a real shop instead of guessed at: "every card is missing availability" is
   * a one-line config change, and invisible from a total.
   */
  private async decide(
    source: ProductSource,
    item: ScrapedListProduct,
  ): Promise<SimulatedListItemDecision> {
    const record = item.url
      ? await this.sourceRecordRepo.findBySourceAndUrl(
          source.id,
          normalizeUrl(item.url),
        )
      : null;

    const missingFields = this.listRefresh.requiredFields.filter((field) => {
      const value = (item as unknown as Record<string, unknown>)[field];
      return value === undefined || value === null || value === '';
    });
    const satisfiesMinimumSet = missingFields.length === 0;

    let reason: string;
    let wouldScrapeDetail: boolean;

    if (!record) {
      reason = 'not seen by this source before — only a detail page has its specs, brand and model';
      wouldScrapeDetail = true;
    } else if (!satisfiesMinimumSet) {
      reason = `known listing, but the card is missing ${missingFields.join(', ')}`;
      wouldScrapeDetail = true;
    } else if (!record.offers?.length) {
      reason = 'known listing with no offer row to refresh yet';
      wouldScrapeDetail = true;
    } else {
      reason = 'refreshed in place from the card — no detail fetch spent';
      wouldScrapeDetail = false;
    }

    return {
      url: item.url,
      externalId: item.externalId,
      price: item.price,
      availability: item.availability,
      known: !!record,
      satisfiesMinimumSet,
      missingFields,
      wouldScrapeDetail,
      reason,
    };
  }

  // ─── arukereso ─────────────────────────────────────────────────────────────

  private async simulateFeed(
    source: ProductSource,
    options: { limit?: number; categorySlugs?: string[] },
    result: ProductSourceImportSimulationResult,
  ): Promise<SimulatedArukeresoImport> {
    const config = asArukeresoConfig(source.config, source.name);
    const limit = options.limit ?? DEFAULT_PREVIEW_LIMIT;

    const { stream, contentType } = await this.nativeScraper.stream(
      config.feedUrl,
    );

    const skipReasons: Partial<Record<FeedSkipReason, number>> = {};
    const externalIds = new Map<string, number>();
    const products: ScrapedProduct[] = [];
    let wouldImport = 0;
    let itemsWithoutExternalId = 0;

    const summary = await this.feedParser.parseStream(
      stream,
      async (item) => {
        // The cheap gate for EVERY item — this is the number worth having, and
        // it costs nothing. Only the first `limit` eligible items are then
        // mapped in full, which is the part that spends LLM calls.
        const classified = await this.mapper.classify(
          config,
          item,
          options.categorySlugs,
        );

        if (classified.status === 'skipped') {
          skipReasons[classified.reason] =
            (skipReasons[classified.reason] ?? 0) + 1;
          return;
        }

        wouldImport += 1;

        const externalId = config.mapping['externalId']
          ? await this.previewExternalId(config, item)
          : undefined;
        if (!externalId) itemsWithoutExternalId += 1;
        else externalIds.set(externalId, (externalIds.get(externalId) ?? 0) + 1);

        if (products.length < limit) {
          const mapped = await this.mapper.map({
            source,
            config,
            item,
            requestedSlugs: options.categorySlugs,
          });
          if (mapped.status === 'mapped') products.push(mapped.scrapedProduct);
        }
      },
      {
        format: config.format ?? 'auto',
        delimiter: config.csv?.delimiter ?? 'auto',
        contentType,
      },
    );

    const duplicateExternalIds = [...externalIds.entries()]
      .filter(([, count]) => count > 1)
      .map(([externalId, count]) => ({ externalId, count }));

    // The check worth failing loudly on. Offer is @Unique([seller, externalId]),
    // so a repeated id does not error — it silently collapses those offers onto
    // one row, keeping only the last imported. speedbike's feed repeats `sku`
    // across size variants for exactly this reason, which is why its config
    // keys on `identifier`.
    if (duplicateExternalIds.length > 0) {
      result.errors.push(
        `${duplicateExternalIds.length} externalId values repeat across eligible items. ` +
          `Offer is unique per (seller, externalId), so those offers WOULD COLLAPSE onto one row each, ` +
          `keeping only the last imported. Map externalId to a field that is unique per variant.`,
      );
    }
    if (wouldImport === 0) {
      result.errors.push(
        'No item survives the category gate — check category.labelFrom, category.slugLookup and categories.<slug>.enabled.',
      );
    }
    if (itemsWithoutExternalId > 0) {
      result.warnings.push(
        `${itemsWithoutExternalId} eligible items carry no externalId and would fall back to the URL slug.`,
      );
    }

    this.logger.debug('Feed import simulated', {
      source: source.name,
      itemsParsed: summary.itemsParsed,
      wouldImport,
      previewed: products.length,
    });

    return {
      feedUrl: config.feedUrl,
      format: summary.format,
      itemsParsed: summary.itemsParsed,
      attributesSkipped: summary.attributesSkipped,
      wouldImport,
      wouldSkip: Object.values(skipReasons).reduce((a, b) => a + b, 0),
      skipReasons,
      distinctExternalIds: externalIds.size,
      duplicateExternalIds: duplicateExternalIds.slice(0, 10),
      itemsWithoutExternalId,
      products,
    };
  }

  /**
   * The externalId a full mapping would produce, without the rest of it.
   *
   * Duplicate detection has to cover the WHOLE feed, and mapping every item to
   * find out would defeat the point of not paying for the LLM.
   */
  private async previewExternalId(
    config: Parameters<ArukeresoProductMapperService['classify']>[0],
    item: Parameters<ArukeresoProductMapperService['classify']>[1],
  ): Promise<string | undefined> {
    const mapping = config.mapping['externalId'];
    if (!mapping) return undefined;

    const raw = mapping.field
      ? item.fields[mapping.field.toLowerCase().replace(/[_\-\s]/g, '')]
      : undefined;

    const value = mapping.pipeline?.length
      ? await this.interpreter.runValuePipeline(mapping.pipeline, raw, {
          baseUrl: config.baseUrl,
        })
      : raw;

    const text = value === undefined || value === null ? '' : String(value).trim();
    return text === '' ? undefined : text;
  }
}
