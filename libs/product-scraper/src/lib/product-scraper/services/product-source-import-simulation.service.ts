import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  ArukeresoMappingEntry,
  ArukeresoMappingTarget,
  asArukeresoConfig,
  asScrapingConfig,
  OfferAvailability,
  OfferCondition,
  OfferRepository,
  ProductSource,
  ProductSourceFetchMode,
  ProductSourceType,
  ScrapedListProduct,
  ScrapedProduct,
  ScrapedProductSpec,
  ProductImportTask,
  isFeedSourceType,
  categorySectionOf,
  ProductSourceCategoryConfig,
  ArukeresoSourceConfig,
  ListingPageRead,
  pageFetchModeOf,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ScraperService } from '@fittkereso-backend/scraper';
import {
  DetailPageSourceConfig,
  ScrapeInterpreterService,
} from '@fittkereso-backend/scrape-interpreter';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  GtinOutcome,
  inspectGtin,
  listingExternalIdOf,
  normalizeMpn,
  urlGroupKey,
} from '@fittkereso-backend/utils';
import { compact, countBy, difference } from 'lodash';
import { BrandResolutionService, selectIdentitySpecRows } from '@fittkereso-backend/product';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';
import { ProductPageReaderService, ProductPageRead } from './product-page-reader.service';
import { ListingReidentificationService } from './listing-reidentification.service';
import { IdentityKeyChange, isNamed } from './listing-identity-key';
import { mergeFeedAndPage, toScrapedPage } from '../../arukereso/merge-feed-and-page';
import { ScrapingImportService } from './scraping-import.service';
import {
  ListItemDecision,
  ListProductRefreshService,
} from './list-product-refresh.service';
import { ArukeresoFeedParserService } from '../../arukereso/arukereso-feed-parser.service';
import { ArukeresoFeedItem } from '../../arukereso/arukereso-feed-item';
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
  toFeedRow,
} from '../../arukereso/arukereso-feed-triage.service';

/** What a run would do with one list card, and why. */
export interface SimulatedListItemDecision {
  url: string;
  externalId?: string;
  price?: number;
  availability?: OfferAvailability;
  /** Whether THIS source already has a ProductSourceRecord for the listing. */
  known: boolean;
  /** ListProductRefreshService's decision; `refresh` is a refresh in place. */
  outcome: ListItemDecision['outcome'];
  satisfiesMinimumSet: boolean;
  /** Fields the minimum set asks for that this card does not carry. */
  missingFields: string[];
  /** The record's URL, when the card found it by externalId under another one. */
  movedFrom?: string;
  /** When a known listing's detail page falls due again (detailRefreshInterval). */
  detailDueAt?: Date;
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
  /** The previewed cards by decision. */
  outcomes: Partial<Record<ListItemDecision['outcome'], number>>;
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
  /**
   * Of wouldQueue, the rows a run would read the product page of (a source
   * with a detailPage): new rows, and rows whose page was never read or is
   * due by detailRefreshInterval. Each page is one fetch however many rows
   * share it.
   */
  wouldFetchPage: number;
  /**
   * For a source that does not identify products: eligible rows whose
   * externalId the seller already has an offer under, which they would join.
   * The rest would wait unattached. Undefined for an identifying source.
   */
  matchingOffers?: number;
  /**
   * Mapped rows whose old price is above their price: what the source would
   * put on the offers as a discount, when no higher-priority source says one.
   */
  rowsWithOldPrice: number;
  /**
   * Mapped rows per condition; `none` is an empty or unrecognised value, which
   * is stored as new. Undefined when the config does not map `condition`.
   */
  conditions?: Partial<Record<OfferCondition | 'none', number>>;
  /**
   * Eligible rows sharing a product page (urlGroupKey) with an earlier row.
   * Each is still its own listing: a page is one task carrying all its rows,
   * and one page read.
   */
  duplicateUrls: number;
  wouldSkip: number;
  skipReasons: Partial<Record<FeedSkipReason, number>>;
  /** Distinct externalIds among eligible items, and any that repeat. */
  distinctExternalIds: number;
  duplicateExternalIds: { externalId: string; count: number }[];
  itemsWithoutExternalId: number;
  /**
   * Fully mapped previews, identity extraction included — the only part that
   * costs LLM calls. A source that does not identify products runs no
   * extraction, so its previews are the mapping alone.
   */
  products: ScrapedProduct[];
  /** Per preview, aligned with `products`: what identity resolution would look up. */
  productIdentifiers: SimulatedListingIdentifiers[];
  /**
   * Per preview, aligned with `products`, for a source with a detailPage: its
   * product page, read and merged in as its page import would — the previews
   * are the merged listings.
   */
  pages?: SimulatedPreviewPage[];
  /**
   * Per preview, aligned with `products`: whether its identity key differs
   * from the one its stored listing was decided under — what puts a listing's
   * product in question (re-identification). Undefined for a source that
   * does not identify products.
   */
  identityKeys: (SimulatedIdentityKeyChange | undefined)[];
  /** Across every eligible item, not just the previews — free either way. */
  identifiers: SimulatedFeedIdentifiers;
}

/** A preview row's product page, as its page import would read it. */
export interface SimulatedPreviewPage {
  url: string;
  /** `detailPage.fetchMode`, else the source's — or the simulation's override. */
  fetchMode: ProductSourceFetchMode;
  /** Why it could not be read: a run retries, then imports the row from the feed alone. */
  error?: string;
  /** The spec rows the page showed. */
  rows: number;
  /** The mapped specs the page filled the row's gaps with: the feed's own stay. */
  filledSpecs: string[];
  /** Whether it gave a row without one its description. */
  filledDescription: boolean;
}

/**
 * A preview row's identity key against the one its stored listing was
 * decided under: `new` without a stored listing, `not_comparable` when either
 * side has no model (an unnamed listing, or a failed extraction).
 */
export type SimulatedIdentityKeyChange =
  | { status: 'new' | 'not_comparable' | 'unchanged' }
  | { status: 'changed'; change: IdentityKeyChange };

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

/** What each category section's identitySpecRows let through, over every eligible item. */
export interface SimulatedSpecRowCoverage {
  /** False when no section lists rows, and every listing sends its whole table. */
  configured: boolean;
  listings: number;
  /** Listings that would send the extraction no spec row at all. */
  listingsWithNoRowSent: number;
  meanRowsSent: number;
  meanRowsTotal: number;
  /**
   * Per configured label of each category section, how many of that
   * category's listings it matched on. A label matching nothing is either a
   * typo or a row the shop has stopped publishing.
   */
  byLabel: { category: string; label: string; listings: number }[];
}

export interface ProductSourceImportSimulationResult {
  type: ProductSourceType;
  sourceName: string;
  /** How this simulation fetched: the source's own mode, or the caller's override. */
  fetchMode: ProductSourceFetchMode;
  scraping?: SimulatedScrapingImport;
  /** A feed source's run: `arukereso` or `googleshop`. */
  feed?: SimulatedArukeresoImport;
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
    private readonly interpreter: ScrapeInterpreterService,
    private readonly scrapingImport: ScrapingImportService,
    private readonly listRefresh: ListProductRefreshService,
    private readonly feedParser: ArukeresoFeedParserService,
    private readonly mapper: ArukeresoProductMapperService,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly feedTriage: ArukeresoFeedTriageService,
    private readonly offerRepo: OfferRepository,
    private readonly pageReader: ProductPageReaderService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly brandResolution: BrandResolutionService,
    private readonly matchQuery: ProductMatchQueryService,
    private readonly reidentification: ListingReidentificationService,
  ) {}

  /**
   * `options.fetchMode` fetches as if the source were in that mode — the check
   * before switching a shop to direct: does it answer, and does the config
   * still read what comes back? Every fetch of the run follows it, the page
   * walk included.
   */
  public async simulate(
    sourceAsStored: ProductSource,
    options: {
      listUrl?: string;
      limit?: number;
      categorySlugs?: string[];
      fetchMode?: ProductSourceFetchMode;
    } = {},
  ): Promise<ProductSourceImportSimulationResult> {
    const source = options.fetchMode
      ? ({ ...sourceAsStored, fetchMode: options.fetchMode } as ProductSource)
      : sourceAsStored;

    const result: ProductSourceImportSimulationResult = {
      type: source.type,
      sourceName: source.name,
      fetchMode: source.fetchMode,
      warnings: [],
      errors: [],
    };

    try {
      if (isFeedSourceType(source.type)) {
        result.feed = await this.simulateFeed(source, options, result);
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
        outcomes: {},
      };
    }

    const $ = cheerio.load(
      await this.scraperService.getHtml(listPageParsed, source.fetchMode),
    );
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
      outcomes: countBy(decisions, (d) => d.outcome),
    };
  }

  /**
   * The decision for one card, made by the same service the real run uses —
   * minus the write.
   *
   * Reporting the reason per item is what makes the minimum set tunable against
   * a real shop instead of guessed at: "every card is missing availability" is
   * a one-line config change, and invisible from a total.
   */
  private async decide(
    source: ProductSource,
    item: ScrapedListProduct,
  ): Promise<SimulatedListItemDecision> {
    const decision = await this.listRefresh.decide(source, item);
    const { outcome, missingFields, movedFrom, detailDueAt } = decision;
    const dueOn = detailDueAt?.toISOString().slice(0, 10);

    const reasons: Record<ListItemDecision['outcome'], string> = {
      unknown: 'not seen by this source before — only a detail page has its specs, brand and model',
      incomplete: `known listing, but the card is missing ${missingFields.join(', ')}`,
      stale: `known listing whose detail page was due again on ${dueOn} (detailRefreshInterval: ${source.detailRefreshInterval})`,
      no_offer: 'known listing with no offer to refresh yet',
      refresh: `refreshed in place from the card — no detail fetch spent; ${
        dueOn ? `detail page due again on ${dueOn}` : "detail page read once, never due again (detailRefreshInterval: 'once')"
      }`,
    };
    let reason = reasons[outcome];
    if (movedFrom) {
      reason += `; the listing moves here from ${movedFrom}`;
    }

    return {
      url: item.url,
      externalId: item.externalId,
      price: item.price,
      availability: item.availability,
      known: !!decision.record,
      outcome,
      satisfiesMinimumSet: missingFields.length === 0,
      missingFields,
      movedFrom,
      detailDueAt,
      wouldScrapeDetail: outcome !== 'refresh',
      reason,
    };
  }

  // ─── arukereso ─────────────────────────────────────────────────────────────

  private async simulateFeed(
    source: ProductSource,
    options: { limit?: number; categorySlugs?: string[]; fetchMode?: ProductSourceFetchMode },
    result: ProductSourceImportSimulationResult,
  ): Promise<SimulatedArukeresoImport> {
    const config = asArukeresoConfig(source.config, source.name);
    const limit = options.limit ?? DEFAULT_PREVIEW_LIMIT;
    const pageConfig = this.pageConfigOf(config, options.fetchMode);
    const pageReads = new Map<string, Promise<ProductPageRead>>();
    const pages: SimulatedPreviewPage[] = [];
    const identityKeys: (SimulatedIdentityKeyChange | undefined)[] = [];
    let wouldFetchPage = 0;

    const { stream, contentType } = await this.scraperService.stream(
      config.feedUrl,
      source.fetchMode,
    );

    const skipReasons: Partial<Record<FeedSkipReason, number>> = {};
    const externalIds = new Map<string, number>();
    const products: ScrapedProduct[] = [];
    let wouldImport = 0;
    let itemsWithoutExternalId = 0;
    const productIdentifiers: SimulatedListingIdentifiers[] = [];
    const identifiers = new FeedIdentifierTally(config.mapping, config.categories);
    // What a run would do with each eligible row, triaged in batches as the
    // run does: one row per listing id, the last for a repeated one, and the
    // first URL a repeated listing id came under.
    const seenUrls = new Set<string>();
    const listingUrls = new Map<string, string>();
    let batch: FeedRow[] = [];
    let wouldQueue = 0;
    let wouldRefresh = 0;
    let duplicateUrls = 0;
    let mappingFailures = 0;
    const contributes = source.identifiesProducts === false;
    let matchingOffers = 0;
    let rowsWithOldPrice = 0;
    const conditions: Partial<Record<OfferCondition | 'none', number>> = {};
    const triageBatch = async () => {
      const unique = [...new Map(batch.map((row) => [row.listingId, row])).values()];
      batch = [];
      if (unique.length === 0) return;
      const triage = await this.feedTriage.triage(source, unique);
      wouldQueue += triage.toImport.length;
      wouldRefresh += triage.unchanged.length;
      wouldFetchPage += triage.needsPage?.size ?? 0;
      if (contributes) {
        matchingOffers += (
          await this.offerRepo.findSyncStates(
            source.seller.id,
            compact(unique.map((row) => row.externalId)),
          )
        ).length;
      }
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

        const identity = {
          category: classified.slug,
          brand: await this.previewTarget(config, item, 'brand'),
          gtin: await this.previewTarget(config, item, 'gtin'),
          mpn: await this.previewTarget(config, item, 'mpn'),
        };

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
          identifiers.add({ ...identity, rawSpecs: toRawSpecs(item) });
          mappingFailures += 1;
          if (mappingFailures === 1) {
            result.warnings.push(
              `An eligible item failed to map: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }
        // The rows the identity extraction picks from: the feed's own, plus
        // the section's extraSpecRows the mapper appends.
        const rawSpecs =
          (mapped.status === 'mapped' ? mapped.scrapedProduct.rawSpecs : undefined) ??
          toRawSpecs(item);
        identifiers.add({ ...identity, rawSpecs });
        if (mapped.status === 'mapped') {
          const row = toFeedRow(mapped, item);
          const firstUrl = listingUrls.get(row.listingId);
          if (firstUrl === undefined || firstUrl === row.url) {
            listingUrls.set(row.listingId, row.url);
            const pageKey = urlGroupKey(mapped.url);
            if (seenUrls.has(pageKey)) duplicateUrls += 1;
            seenUrls.add(pageKey);
            const offer = mapped.scrapedProduct.offers?.[0];
            if (offer?.priceWithoutDiscount && offer.priceWithoutDiscount > offer.price) {
              rowsWithOldPrice += 1;
            }
            if (offer && offer.condition !== undefined) {
              const condition = offer.condition ?? 'none';
              conditions[condition] = (conditions[condition] ?? 0) + 1;
            }
            batch.push(row);
            if (batch.length >= TRIAGE_BATCH) await triageBatch();
          }
        }

        if (products.length < limit) {
          if (mapped.status === 'mapped') {
            // The mapping itself is free; the preview then reads the row's
            // page, when the source has a detailPage, and runs the identity
            // extraction a first import would — the parts that cost, unless
            // the source's `postProcess.identity` is off, contributing or not.
            // `force` rules out reusing a stored result.
            const { listing, page, pageRead } = await this.previewPage(
              source,
              pageConfig,
              mapped,
              pageReads,
            );
            if (page) pages.push(page);
            const extracted = await this.specPostProcess.extractIdentity({
              context: {
                source,
                url: mapped.url,
                force: true,
                feedListing: mapped.scrapedProduct,
                pageRead,
              },
              scrapedProduct: listing,
            });
            products.push(extracted);
            identityKeys.push(await this.identityKeyChangeOf(source, mapped.url, extracted));
            const offer = extracted.offers?.[0];
            productIdentifiers.push(
              previewListingIdentifiers({
                externalId: offer?.externalId,
                gtin: offer?.gtin,
                mpn: offer?.mpn,
                // The rows the extraction was given: the feed's, then its page's.
                rawSpecs: listing.rawSpecs ?? rawSpecs,
                specRows: categorySectionOf(config, classified.slug)
                  ?.identitySpecRows,
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

    const duplicateExternalIds = [...externalIds.entries()]
      .filter(([, count]) => count > 1)
      .map(([externalId, count]) => ({ externalId, count }));

    // The check worth failing loudly on. A listing's record is unique per
    // (source, externalId), and its offer per (seller, externalId): a run
    // imports only the first row of a repeated id, and the rest never arrive.
    // speedbike's feed repeats `sku` across size variants for exactly this
    // reason, which is why its config keys on `identifier`.
    if (duplicateExternalIds.length > 0) {
      result.errors.push(
        `${duplicateExternalIds.length} externalId values repeat across eligible items. ` +
          `A listing is unique per (source, externalId), so a run imports only the first row of each ` +
          `and skips the rest. Map externalId to a field that is unique per variant.`,
      );
    }
    if (wouldImport === 0) {
      result.errors.push(
        "No item survives the category gate — check category.labelFrom, and each categories.<slug> section's rules and enabled.",
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
    // A source that does not identify products runs no identity extraction.
    if (!contributes && identifierSummary.specRows.listingsWithNoRowSent > 0) {
      result.warnings.push(
        `${identifierSummary.specRows.listingsWithNoRowSent} eligible items match none of their category section's identitySpecRows, so their identity extraction would see the title alone. Check the labels against the feed's attribute names.`,
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
      wouldFetchPage,
      matchingOffers: contributes ? matchingOffers : undefined,
      rowsWithOldPrice,
      conditions: this.mapper.isMapped(config, 'condition') ? conditions : undefined,
      duplicateUrls,
      wouldSkip: Object.values(skipReasons).reduce((a, b) => a + b, 0),
      skipReasons,
      distinctExternalIds: externalIds.size,
      duplicateExternalIds: duplicateExternalIds.slice(0, 10),
      itemsWithoutExternalId,
      products,
      productIdentifiers,
      ...(pageConfig ? { pages } : {}),
      identityKeys,
      identifiers: identifierSummary,
    };
  }

  /**
   * What a feed's product pages are read with, as its page tasks read them:
   * the detailPage, in the simulation's fetch mode when it overrides the
   * source's — the tool's argument wins over `detailPage.fetchMode` too.
   * Undefined for a feed without a detailPage.
   */
  private pageConfigOf(
    config: ArukeresoSourceConfig,
    fetchMode: ProductSourceFetchMode | undefined,
  ): DetailPageSourceConfig | undefined {
    if (!config.detailPage) return undefined;
    return {
      baseUrl: config.baseUrl,
      categories: config.categories,
      detailPage: { ...config.detailPage, ...(fetchMode ? { fetchMode } : {}) },
    };
  }

  /**
   * A preview row with its product page merged in, as its page import would
   * make it — the feed primary, the page filling its gaps — and what the page
   * gave. A page read once serves every preview row of it. A page that cannot
   * be read leaves the row as the feed has it, as a run's last attempt would.
   */
  private async previewPage(
    source: ProductSource,
    pageConfig: DetailPageSourceConfig | undefined,
    mapped: { url: string; scrapedProduct: ScrapedProduct },
    pageReads: Map<string, Promise<ProductPageRead>>,
  ): Promise<{ listing: ScrapedProduct; page?: SimulatedPreviewPage; pageRead?: ListingPageRead }> {
    const row = mapped.scrapedProduct;
    if (!pageConfig) return { listing: row };

    const fetchMode = pageFetchModeOf(source, pageConfig.detailPage);
    const key = `${urlGroupKey(mapped.url)} ${row.category.slug}`;
    if (!pageReads.has(key)) {
      pageReads.set(
        key,
        this.pageReader.read({
          task: { url: mapped.url, force: true, source } as unknown as ProductImportTask,
          config: pageConfig,
          category: row.category,
          expectedExternalIds: [
            row.externalId,
            ...(row.offers ?? []).flatMap((offer) => [offer.externalId, offer.mpn, offer.gtin]),
          ],
        }),
      );
    }

    try {
      const read = (await pageReads.get(key)) as ProductPageRead;
      const offerLevelKeys =
        this.categoryConfigService.getConfig(row.category.slug)?.offerLevelSpecs ?? [];
      const listing = mergeFeedAndPage(row, toScrapedPage(read, 1), offerLevelKeys);
      return {
        listing,
        pageRead: { fetchedAt: new Date() },
        page: {
          url: read.url,
          fetchMode,
          rows: read.detail.rawSpecs.length,
          filledSpecs: difference(
            Object.keys(listing.extractedSpecs ?? {}),
            Object.keys(row.extractedSpecs ?? {}),
          ).sort(),
          filledDescription: !row.description?.trim() && !!listing.description?.trim(),
        },
      };
    } catch (error: unknown) {
      return {
        listing: row,
        page: {
          url: mapped.url,
          fetchMode,
          error: error instanceof Error ? error.message : String(error),
          rows: 0,
          filledSpecs: [],
          filledDescription: false,
        },
      };
    }
  }

  /**
   * Whether a preview's identity key differs from the one its stored listing
   * was decided under: what would put its product in question.
   */
  private async identityKeyChangeOf(
    source: ProductSource,
    url: string,
    extracted: ScrapedProduct,
  ): Promise<SimulatedIdentityKeyChange | undefined> {
    if (source.identifiesProducts === false) return undefined;
    const record = await this.sourceRecordRepo.findBySourceAndExternalId(
      source.id,
      listingExternalIdOf(extracted, url),
    );
    if (!record) return { status: 'new' };
    if (!isNamed(extracted)) return { status: 'not_comparable' };

    const brand = await this.brandResolution.resolve(extracted.brand, extracted.originalName);
    const change = this.reidentification.keyChangeOf({
      extracted,
      normalizedModel: this.matchQuery.normalizedModelOf(extracted, brand?.entity?.name) ?? null,
      identifiers: (extracted.offers ?? []).map((offer) => ({
        gtin: inspectGtin(offer.gtin).gtin,
        mpn: normalizeMpn(offer.mpn),
      })),
      record,
    });
    if (change === null) return { status: 'not_comparable' };
    return change ? { status: 'changed', change } : { status: 'unchanged' };
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

  /** One mapping target's value, as the mapper resolves it (fallback lists included). */
  private async previewTarget(
    config: Parameters<ArukeresoProductMapperService['classify']>[0],
    item: Parameters<ArukeresoProductMapperService['classify']>[1],
    target: ArukeresoMappingTarget,
  ): Promise<string | undefined> {
    const value = await this.mapper.resolveTarget(config, item, target);
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
  /** Hits per section and label, keyed by slug and label joined with a NUL. */
  private readonly labelHits: Map<string, number>;
  private listings = 0;
  private listingsWithNoRowSent = 0;
  private rowsSent = 0;
  private rowsTotal = 0;

  constructor(
    private readonly mapping: Record<string, ArukeresoMappingEntry>,
    private readonly categories: Record<string, ProductSourceCategoryConfig> | undefined,
  ) {
    this.labelHits = new Map(
      Object.entries(categories ?? {}).flatMap(([slug, section]) =>
        (section.identitySpecRows ?? []).map((label) => [`${slug}\u0000${label}`, 0] as const),
      ),
    );
  }

  add(item: {
    category: string;
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

    const specRows = this.categories?.[item.category]?.identitySpecRows;
    const sent = selectIdentitySpecRows(item.rawSpecs, specRows);
    this.rowsSent += sent.length;
    this.rowsTotal += item.rawSpecs.length;
    if (sent.length === 0) this.listingsWithNoRowSent += 1;

    for (const label of specRows ?? []) {
      if (selectIdentitySpecRows(item.rawSpecs, [label]).length > 0) {
        const key = `${item.category}\u0000${label}`;
        this.labelHits.set(key, (this.labelHits.get(key) ?? 0) + 1);
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
        configured: Object.values(this.categories ?? {}).some(
          (section) => !!section.identitySpecRows?.length,
        ),
        listings: this.listings,
        listingsWithNoRowSent: this.listingsWithNoRowSent,
        meanRowsSent: mean(this.rowsSent),
        meanRowsTotal: mean(this.rowsTotal),
        byLabel: [...this.labelHits].map(([key, listings]) => {
          const [category, label] = key.split('\u0000');
          return { category, label, listings };
        }),
      },
    };
  }
}
