import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { compact, uniq } from 'lodash';
import {
  ListingExternalIdMismatchError,
  ProductImportTask,
  ProductSourceDetailPageConfig,
  ProductSourceFetchMode,
  ProductSpecs,
  SourceSpecConfig,
  categorySectionOf,
  pageFetchModeOf,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';
import { normalizeUrl } from '@fittkereso-backend/utils';
import {
  ScrapedProduct,
  ScrapedProductSpec,
  SpecExtractionService,
  SpecTranslationSelectorService,
  getVerbatimSpecKeys,
} from '@fittkereso-backend/product';
import {
  DetailPageResult,
  DetailPageSourceConfig,
  RuntimeDataProviderService,
  ScrapeInterpreterService,
} from '@fittkereso-backend/scrape-interpreter';
import { TranslationService } from '@fittkereso-backend/translation';

/** The category a page's specs are mapped for. */
export type PageCategory = ScrapedProduct['category'];

type CategoryJsonSchema = NonNullable<ReturnType<CategoryConfigService['getJsonSchema']>>;

/**
 * Why a page's category is unusable. Returned, not thrown: a scraping source
 * throws on some and skips on others, a feed source never asks (it brings its
 * own category), so each caller keeps its own reaction.
 */
export type PageCategoryProblem =
  | { reason: 'ambiguous'; slugs: string[] }
  | { reason: 'not_identified'; slug?: string }
  | { reason: 'not_enabled'; slug: string }
  | { reason: 'no_schema'; slug: string };

/** A fetched and interpreted page, before any spec is mapped. */
export interface PageInterpretation {
  /** The URL fetched, normalized. */
  url: string;
  /** How it was fetched: `detailPage.fetchMode`, else the source's. */
  fetchMode: ProductSourceFetchMode;
  /** How much HTML came back: a blocked or empty answer is short. */
  htmlLength: number;
  detail: DetailPageResult;
  /** The caller's category, else the page's; absent with a categoryProblem. */
  category?: PageCategory;
  /** The category's spec schema; absent with a categoryProblem. */
  schema?: CategoryJsonSchema;
  categoryProblem?: PageCategoryProblem;
}

/** A page read in full: interpreted, and its rows mapped onto the category's specs. */
export interface ProductPageRead extends PageInterpretation {
  /**
   * The deterministic specs its rows map to through the category section's
   * specMapping (translated when the detailPage says so) — before any fold.
   * Absent with a categoryProblem.
   */
  specs?: ProductSpecs;
  /** What the page said, hashed: its rows and description. */
  contentHash: string;
}

interface ReadParams {
  task: ProductImportTask;
  /** baseUrl, the category sections and the detailPage to read the page with. */
  config: DetailPageSourceConfig;
  /**
   * The category to map the specs for. A feed source passes its row's; a
   * scraping source passes none, and the page's own is resolved.
   */
  category?: PageCategory;
  /**
   * The ids the page must show, when it states any: a scraping card's, or a
   * feed URL's rows'. A page naming none of them is another product.
   */
  expectedExternalIds?: (string | undefined | null)[];
}

/**
 * Reads a product detail page — the one service both a scraping source's
 * detail task and a feed source's page task read pages with:
 * fetch (in `detailPage.fetchMode ?? source.fetchMode`), the interpreter's
 * detailPage parts, the check that the page is the expected product, the
 * category, and the rows mapped onto that category's specs.
 *
 * What a caller does with the result is its own: a scraping source builds the
 * whole listing from it, a feed source fills its row's gaps (mergeFeedAndPage).
 */
@Injectable()
export class ProductPageReaderService {
  private readonly logger = new CustomLogger(ProductPageReaderService.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly runtime: RuntimeDataProviderService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly specExtraction: SpecExtractionService,
    private readonly translationSelector: SpecTranslationSelectorService,
    private readonly translationService: TranslationService,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
  ) {}

  /** interpret, then mapSpecs when the category is usable. */
  public async read(params: ReadParams): Promise<ProductPageRead> {
    const interpretation = await this.interpret(params);
    const contentHash = pageContentHash(interpretation.detail);
    if (interpretation.categoryProblem) return { ...interpretation, contentHash };

    const specs = await this.mapSpecs({ task: params.task, config: params.config, interpretation });
    return { ...interpretation, specs, contentHash };
  }

  /**
   * Fetch the page, run the detailPage parts, refuse another product's page,
   * and settle the category. No spec is mapped yet: a caller that still has a
   * reason to skip the page (a scraping source without a brand) spends no
   * translation on it.
   */
  public async interpret(params: ReadParams): Promise<PageInterpretation> {
    const { task, config } = params;
    const url = normalizeUrl(task.url);
    const fetchMode = pageFetchModeOf(task.source, config.detailPage);
    const html = await this.scraperService.getHtml(url, fetchMode);
    const detail = await this.interpreter.runDetailPage(task, cheerio.load(html), config);

    this.assertExpectedProduct(task, url, detail, params.expectedExternalIds);

    const base = { url, fetchMode, htmlLength: html.length, detail };
    const category = params.category ?? (await this.categoryOfPage(config, detail));
    if ('reason' in category) return { ...base, categoryProblem: category };

    const schema = this.categoryConfigService.getJsonSchema(category.slug);
    if (!schema) return { ...base, categoryProblem: { reason: 'no_schema', slug: category.slug } };

    return { ...base, category, schema };
  }

  /**
   * The page's rows mapped onto its category's specs through the section's
   * specMapping — translated first when `detailPage.translation` is on. No
   * mapping for the category gives no specs.
   */
  public async mapSpecs(params: {
    task: ProductImportTask;
    config: DetailPageSourceConfig;
    interpretation: PageInterpretation;
  }): Promise<ProductSpecs> {
    const { task, config, interpretation } = params;
    const { category, schema, detail } = interpretation;
    if (!category || !schema) return {};

    const offerLevelKeys = this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs ?? [];
    const sourceConfig = categorySectionOf(config, category.slug)?.specMapping;
    if (!sourceConfig) return {};

    const untranslatedKeys = getVerbatimSpecKeys(schema, offerLevelKeys);
    const translator = await this.buildTranslator(
      task,
      config.detailPage.translation,
      detail.rawSpecs,
      sourceConfig,
      category.name,
      untranslatedKeys,
    );
    return this.specExtraction.extractSpecs({
      scrapedSpecs: detail.rawSpecs,
      schema,
      sourceConfig,
      translator,
      untranslatedKeys,
    });
  }

  /** The page's own category, or why it has none usable. */
  private async categoryOfPage(
    config: DetailPageSourceConfig,
    detail: DetailPageResult,
  ): Promise<PageCategory | PageCategoryProblem> {
    if (detail.ambiguousCategorySlugs?.length) {
      return { reason: 'ambiguous', slugs: detail.ambiguousCategorySlugs };
    }
    if (!detail.categorySlug) return { reason: 'not_identified' };

    const enabled = categorySectionOf(config, detail.categorySlug)?.enabled ?? false;
    if (!enabled) return { reason: 'not_enabled', slug: detail.categorySlug };

    const category = await this.runtime.getCategoryBySlug(detail.categorySlug);
    if (!category) return { reason: 'not_identified', slug: detail.categorySlug };
    return { id: category.id, slug: category.slug, name: category.name };
  }

  /**
   * Refuses a page that shows another product than the one expected.
   *
   * A shop that never answers a product URL with a 404 (ebikeshop) redirects a
   * delisted product's URL to some other product, and the fetch follows the
   * redirect: importing that page would file the other product under this
   * listing. Checked before anything is written or sent to an LLM.
   *
   * The expected ids are matched against the page's own and its offers', since
   * a page may carry either (a product code, or a size's). A page that states
   * no id at all is let through: it may be a block page, which a retry can get
   * past.
   */
  private assertExpectedProduct(
    task: ProductImportTask,
    url: string,
    detail: DetailPageResult,
    expectedExternalIds: (string | undefined | null)[] | undefined,
  ): void {
    const expected = uniq(compact((expectedExternalIds ?? []).map(toExternalId)));
    if (expected.length === 0) return;

    const onPage = uniq(
      compact([detail.externalId, ...detail.rawOffers.map((offer) => offer.externalId)].map(toExternalId)),
    );
    if (onPage.length === 0 || onPage.some((id) => expected.includes(id))) return;

    this.logger.warn('The page shows another product than the listing that queued it', {
      taskId: task.id,
      url,
      expectedExternalIds: expected,
      pageExternalIds: onPage,
    });
    this.scrapingMetrics.recordExtractionSkipReason(task.source.name, 'external_id_mismatch');
    throw new ListingExternalIdMismatchError({
      source: task.source,
      url,
      expectedExternalId: expected.join(', '),
      pageExternalIds: onPage,
    });
  }

  private async buildTranslator(
    task: ProductImportTask,
    translationConfig: ProductSourceDetailPageConfig['translation'],
    rawSpecs: ScrapedProductSpec[],
    sourceConfig: SourceSpecConfig | undefined,
    categoryName: string,
    untranslatedKeys: string[],
  ) {
    if (!translationConfig?.enabled) {
      return undefined;
    }

    const rawValues = this.translationSelector.collectTranslatableValues(
      rawSpecs,
      sourceConfig,
      untranslatedKeys,
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

/**
 * What a page said, hashed: its rows and description. Equal hashes mean an
 * unchanged page, whatever its markup did meanwhile.
 */
export function pageContentHash(detail: Pick<DetailPageResult, 'rawSpecs' | 'description'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ rawSpecs: detail.rawSpecs, description: detail.description ?? null }))
    .digest('hex');
}

/** An externalId as text, or undefined when there is none: a page's JSON may hold a number. */
export function toExternalId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
