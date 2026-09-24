import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  ArukeresoFieldMapping,
  ArukeresoMappingTarget,
  asArukeresoConfig,
  asScrapingConfig,
  OfferAvailability,
  ProductSource,
  ProductSourceRecordRepository,
  ProductSourceType,
  ScrapedListProduct,
  ScrapedProduct,
  ScrapedProductSpec,
  ProductImportTask,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { NativeScraperService, ScraperService } from '@fittkereso-backend/scraper';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import {
  GtinOutcome,
  inspectGtin,
  normalizeMpn,
  normalizeUrl,
} from '@fittkereso-backend/utils';
import { selectIdentitySpecRows } from '@fittkereso-backend/product';
import { ScrapingImportService } from './scraping-import.service';
import { ListProductRefreshService } from './list-product-refresh.service';
import { ArukeresoFeedParserService } from '../../arukereso/arukereso-feed-parser.service';
import {
  ArukeresoFeedItem,
  feedField,
} from '../../arukereso/arukereso-feed-item';
import {
  previewListingIdentifiers,
  SimulatedListingIdentifiers,
} from './identifier-preview';
import { SpecPostProcessService } from './spec-post-process.service';
import {
  ArukeresoProductMapperService,
  FeedSkipReason,
} from '../../arukereso/arukereso-product-mapper.service';
import {
  ArukeresoFeedTriageService,
  FeedRow,
} from '../../arukereso/arukereso-feed-triage.service';
import { feedRowHash } from '../../arukereso/feed-row-hash';
import { offerExternalIdOf } from './offer-external-id';

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
  /**
   * Of wouldImport, what a run would do right now: queue a feed_entry task
   * (new, changed, or missing its offer), or only confirm the offer in place.
   */
  wouldQueue: number;
  wouldRefresh: number;
  /** Eligible rows sharing a URL with an earlier row: only the last is imported. */
  duplicateUrls: number;
  wouldSkip: number;
  skipReasons: Partial<Record<FeedSkipReason, number>>;
  /** Distinct externalIds among eligible items, and any that repeat. */
  distinctExternalIds: number;
  duplicateExternalIds: { externalId: string; count: number }[];
  itemsWithoutExternalId: number;
  /** Fully mapped previews, identity extraction included — the only part that costs LLM calls. */
  products: ScrapedProduct[];
  /** Per preview, aligned with `products`: what identity resolution would look up. */
  productIdentifiers: SimulatedListingIdentifiers[];
  /** Across every eligible item, not just the previews — free either way. */
  identifiers: SimulatedFeedIdentifiers;
}

/** How a feed's identifiers would fare, counted over every eligible item. */
export interface SimulatedFeedIdentifiers {
  gtinMapped: boolean;
  gtin: Record<GtinOutcome, number>;
  /**
   * Invalid GTINs per brand. A shop that fills its barcode field with its own
   * article stubs usually does it for a few brands (speedbike: GIANT and LIV),
   * which is what tells a data quirk apart from a mapping pointing at the
   * wrong field.
   */
  invalidGtinByBrand: Record<string, number>;
  invalidGtinSamples: string[];
  mpnMapped: boolean;
  mpn: Record<GtinOutcome, number>;
  specRows: SimulatedSpecRowCoverage;
}

/** What identityExtraction.specRows lets through, over every eligible item. */
export interface SimulatedSpecRowCoverage {
  /** False when the source lists no rows, and every listing sends its whole table. */
  configured: boolean;
  listings: number;
  /** Listings that would send the extraction no spec row at all. */
  listingsWithNoRowSent: number;
  meanRowsSent: number;
  meanRowsTotal: number;
  /**
   * Per configured label, how many listings it matched on. A label matching
   * nothing is either a typo or a row the shop has stopped publishing.
   */
  byLabel: { label: string; listings: number }[];
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

/** Rows triaged per lookup, the feed run's own batch size. */
const TRIAGE_BATCH = 200;

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
    private readonly specPostProcess: SpecPostProcessService,
    private readonly feedTriage: ArukeresoFeedTriageService,
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
      { id: 'simulate', url: listPageParsed, source } as ProductImportTask,
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
    const productIdentifiers: SimulatedListingIdentifiers[] = [];
    const identifiers = new FeedIdentifierTally(
      config.mapping,
      config.identityExtraction?.specRows,
    );
    // What a run would do with each eligible row, triaged in batches as the
    // run does (last row wins for a repeated URL).
    const seenUrls = new Set<string>();
    let batch: FeedRow[] = [];
    let wouldQueue = 0;
    let wouldRefresh = 0;
    let duplicateUrls = 0;
    let mappingFailures = 0;
    const triageBatch = async () => {
      const unique = [...new Map(batch.map((row) => [row.url, row])).values()];
      batch = [];
      if (unique.length === 0) return;
      const triage = await this.feedTriage.triage(source, unique);
      wouldQueue += triage.toImport.length;
      wouldRefresh += triage.unchanged.length;
    };

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

        identifiers.add({
          brand: await this.previewTarget(config, item, 'brand'),
          gtin: await this.previewTarget(config, item, 'gtin'),
          mpn: await this.previewTarget(config, item, 'mpn'),
          rawSpecs: toRawSpecs(item),
        });

        // Every eligible row is mapped — deterministic and free — so the
        // triage below covers the whole feed, exactly as a run would.
        let mapped: Awaited<ReturnType<ArukeresoProductMapperService['map']>>;
        try {
          mapped = await this.mapper.map({
            config,
            item,
            requestedSlugs: options.categorySlugs,
          });
        } catch (error: unknown) {
          mappingFailures += 1;
          if (mappingFailures === 1) {
            result.warnings.push(
              `An eligible item failed to map: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }
        if (mapped.status === 'mapped') {
          if (seenUrls.has(mapped.url)) duplicateUrls += 1;
          seenUrls.add(mapped.url);
          const offer = mapped.scrapedProduct.offers?.[0];
          batch.push({
            url: mapped.url,
            item,
            scrapedProduct: mapped.scrapedProduct,
            rowHash: feedRowHash(mapped.url, mapped.scrapedProduct),
            externalId: offer ? offerExternalIdOf(offer, mapped.url).value : undefined,
          });
          if (batch.length >= TRIAGE_BATCH) await triageBatch();
        }

        if (products.length < limit) {
          if (mapped.status === 'mapped') {
            // The mapping itself is free; the preview then runs the identity
            // extraction a first import would, which is the part that costs.
            // `force` rules out reusing a stored result.
            const extracted = await this.specPostProcess.extractIdentity({
              context: { source, url: mapped.url, force: true },
              scrapedProduct: mapped.scrapedProduct,
            });
            products.push(extracted);
            const offer = extracted.offers?.[0];
            productIdentifiers.push(
              previewListingIdentifiers({
                externalId: offer?.externalId,
                gtin: offer?.gtin,
                mpn: offer?.mpn,
                rawSpecs: toRawSpecs(item),
                specRows: config.identityExtraction?.specRows,
              }),
            );
          }
        }
      },
      {
        format: config.format ?? 'auto',
        delimiter: config.csv?.delimiter ?? 'auto',
        contentType,
      },
    );

    await triageBatch();
    if (mappingFailures > 0) {
      result.warnings.push(
        `${mappingFailures} eligible items failed to map; a run would count them as failed and skip them.`,
      );
    }
    if (duplicateUrls > 0) {
      result.warnings.push(
        `${duplicateUrls} eligible items share a URL with an earlier one, so a run imports only the last row of each. Is mapping.url unique per variant?`,
      );
    }

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
    const identifierSummary = identifiers.summary();
    if (
      identifierSummary.gtinMapped &&
      identifierSummary.gtin.invalid > identifierSummary.gtin.valid
    ) {
      result.warnings.push(
        `More GTINs are invalid (${identifierSummary.gtin.invalid}) than valid (${identifierSummary.gtin.valid}). Invalid ones are dropped rather than matched on, but this many usually means mapping.gtin points at a field that is not a barcode.`,
      );
    }
    if (identifierSummary.specRows.listingsWithNoRowSent > 0) {
      result.warnings.push(
        `${identifierSummary.specRows.listingsWithNoRowSent} eligible items match none of identityExtraction.specRows, so their identity extraction would see the title alone. Check the labels against the feed's attribute names.`,
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
      wouldQueue,
      wouldRefresh,
      duplicateUrls,
      wouldSkip: Object.values(skipReasons).reduce((a, b) => a + b, 0),
      skipReasons,
      distinctExternalIds: externalIds.size,
      duplicateExternalIds: duplicateExternalIds.slice(0, 10),
      itemsWithoutExternalId,
      products,
      productIdentifiers,
      identifiers: identifierSummary,
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
    return this.previewTarget(config, item, 'externalId');
  }

  /** One mapping target's value, resolved the way the mapper resolves it. */
  private async previewTarget(
    config: Parameters<ArukeresoProductMapperService['classify']>[0],
    item: Parameters<ArukeresoProductMapperService['classify']>[1],
    target: ArukeresoMappingTarget,
  ): Promise<string | undefined> {
    const mapping = config.mapping[target];
    if (!mapping) return undefined;

    const raw = mapping.field ? feedField(item, mapping.field) : undefined;

    const value = mapping.pipeline?.length
      ? await this.interpreter.runValuePipeline(mapping.pipeline, raw, {
          baseUrl: config.baseUrl,
        })
      : raw;

    const text = value === undefined || value === null ? '' : String(value).trim();
    return text === '' ? undefined : text;
  }
}

/** A feed item's attribute pairs as spec rows — the table the mapper extracts from. */
function toRawSpecs(item: ArukeresoFeedItem): ScrapedProductSpec[] {
  return item.attributes.map((attribute) => ({
    name: attribute.name,
    values: [attribute.value],
  }));
}

/** Running counts behind SimulatedFeedIdentifiers. */
class FeedIdentifierTally {
  private readonly gtin: Record<GtinOutcome, number> = { valid: 0, invalid: 0, absent: 0 };
  private readonly mpn: Record<GtinOutcome, number> = { valid: 0, invalid: 0, absent: 0 };
  private readonly invalidGtinByBrand: Record<string, number> = {};
  private readonly invalidGtinSamples: string[] = [];
  private readonly labelHits: Map<string, number>;
  private listings = 0;
  private listingsWithNoRowSent = 0;
  private rowsSent = 0;
  private rowsTotal = 0;

  constructor(
    private readonly mapping: Record<string, ArukeresoFieldMapping>,
    private readonly specRows: string[] | undefined,
  ) {
    this.labelHits = new Map((specRows ?? []).map((label) => [label, 0]));
  }

  add(item: {
    brand?: string;
    gtin?: string;
    mpn?: string;
    rawSpecs: ScrapedProductSpec[];
  }): void {
    this.listings += 1;

    const { outcome } = inspectGtin(item.gtin);
    this.gtin[outcome] += 1;
    if (outcome === 'invalid') {
      const brand = item.brand ?? '(no brand)';
      this.invalidGtinByBrand[brand] = (this.invalidGtinByBrand[brand] ?? 0) + 1;
      if (this.invalidGtinSamples.length < 5) {
        this.invalidGtinSamples.push(String(item.gtin));
      }
    }

    this.mpn[normalizeMpn(item.mpn) ? 'valid' : item.mpn ? 'invalid' : 'absent'] += 1;

    const sent = selectIdentitySpecRows(item.rawSpecs, this.specRows);
    this.rowsSent += sent.length;
    this.rowsTotal += item.rawSpecs.length;
    if (sent.length === 0) this.listingsWithNoRowSent += 1;

    for (const label of this.labelHits.keys()) {
      if (selectIdentitySpecRows(item.rawSpecs, [label]).length > 0) {
        this.labelHits.set(label, (this.labelHits.get(label) ?? 0) + 1);
      }
    }
  }

  summary(): SimulatedFeedIdentifiers {
    const mean = (sum: number) =>
      this.listings ? Math.round((sum / this.listings) * 10) / 10 : 0;
    return {
      gtinMapped: !!this.mapping['gtin'],
      gtin: this.gtin,
      invalidGtinByBrand: this.invalidGtinByBrand,
      invalidGtinSamples: this.invalidGtinSamples,
      mpnMapped: !!this.mapping['mpn'],
      mpn: this.mpn,
      specRows: {
        configured: !!this.specRows?.length,
        listings: this.listings,
        listingsWithNoRowSent: this.listingsWithNoRowSent,
        meanRowsSent: mean(this.rowsSent),
        meanRowsTotal: mean(this.rowsTotal),
        byLabel: [...this.labelHits].map(([label, listings]) => ({ label, listings })),
      },
    };
  }
}
