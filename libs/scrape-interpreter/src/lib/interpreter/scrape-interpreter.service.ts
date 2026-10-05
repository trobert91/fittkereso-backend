import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import {
  CategoryLookupCondition,
  categoryRulesOf,
  ProductSourceCategoryConfig,
  ScrapingSourceConfig,
  ProductSpecs,
  ScrapeOperation,
  ProductImportTask,
} from '@fittkereso-backend/database';
import { ScrapedProductSpec, WebLink } from '@fittkereso-backend/product';
import { ScrapedListProduct } from '@fittkereso-backend/database';
import { ScrapePipelineRunnerService } from './services/scrape-pipeline-runner.service';
import { RuntimeDataProviderService } from './services/runtime-data-provider.service';
import { ScrapeExecutionContext } from './interfaces/scrape-execution-context.interface';

export interface ListPageResult {
  categoryName?: string;
  /** The product cards on this page. */
  products: ScrapedListProduct[];
}

/**
 * One offer as the interpreter read it. An optional field is `null` when its
 * sub-pipeline is configured and found nothing, and absent when it is not
 * configured — see ScrapedOffer for why the two differ.
 */
export interface RawOfferRecord {
  price?: number;
  priceWithoutDiscount?: number | null;
  currency?: string | null;
  availability?: string | null;
  condition?: string | null;
  url?: string | null;
  externalId?: string;
  gtin?: string | null;
  mpn?: string | null;
  locations?: string[] | null;
  specs?: ProductSpecs;
}

/**
 * Which category section a listing falls in: exactly one section's rules
 * match, none does, or several do — an ambiguity no rule order settles.
 */
export type CategoryResolution =
  | { status: 'resolved'; slug: string }
  | { status: 'unidentified' }
  | { status: 'ambiguous'; slugs: string[] };

export interface DetailPageResult {
  rawSpecs: ScrapedProductSpec[];
  description?: string;
  /** The one category whose section's rules matched; undefined otherwise. */
  categorySlug: string | undefined;
  /** Set when the rules of several category sections matched. */
  ambiguousCategorySlugs?: string[];
  brand: string | undefined;
  model: string | undefined;
  aliases?: string[];
  releaseYear?: number;
  /** detailPage.externalId as text, trimmed — absent when not configured or blank. */
  externalId?: string;
  /** detailPage.siblingIds, trimmed and deduped — absent when not configured or empty. */
  siblingIds?: string[];
  imageUrls: string[];
  rawOffers: RawOfferRecord[];
  offerLinks: WebLink[];
}

@Injectable()
export class ScrapeInterpreterService {
  constructor(
    private readonly runner: ScrapePipelineRunnerService,
    private readonly runtime: RuntimeDataProviderService,
  ) {}

  private makeContext(
    task: ProductImportTask,
    $: CheerioAPI,
    config: ScrapingSourceConfig,
    opts: Record<string, unknown> = {},
  ): ScrapeExecutionContext {
    return {
      $,
      html: $.html(),
      task,
      vars: { baseUrl: config.baseUrl },
      runtime: this.runtime,
      opts,
    };
  }

  /**
   * Run an arbitrary configured pipeline against a page.
   *
   * For pipelines that belong to a source's config but not to any one page
   * role — `categoryLinks` and `listPage.pagination.pageCount`, both of which
   * ScrapingImportService evaluates once per run rather than per task.
   */
  public async runPipeline(
    pipeline: ScrapeOperation[],
    task: ProductImportTask,
    $: CheerioAPI,
    config: ScrapingSourceConfig,
  ): Promise<unknown> {
    return this.runner.run(pipeline, this.makeContext(task, $, config));
  }

  /**
   * Run a pipeline over a plain value, with no page behind it.
   *
   * What the Árukereső importer needs: a feed field is already a string, so its
   * mapping pipeline is a value transform (`regexCapture`, `mapValue`,
   * `splitAndTake`) rather than a DOM query. The context still carries a
   * CheerioAPI because every op signature expects one — an empty document, so
   * a DOM op that somehow reaches here selects nothing instead of throwing.
   *
   * `vars.baseUrl` is seeded for the same reason it is on the page paths: ops
   * like `resolveUrl` read it, and a feed's relative image URLs need it.
   */
  public async runValuePipeline(
    pipeline: ScrapeOperation[],
    input: unknown,
    opts: { baseUrl?: string; vars?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const ctx: ScrapeExecutionContext = {
      $: cheerio.load(''),
      html: '',
      // No task exists on a feed run — nothing in a value pipeline reads it,
      // and inventing a throwaway ProductImportTask row to satisfy a type would put
      // fake work in a table the workers poll.
      task: undefined as unknown as ProductImportTask,
      vars: { baseUrl: opts.baseUrl, ...(opts.vars ?? {}) },
      runtime: this.runtime,
      opts: {},
    };

    return this.runner.run(pipeline, ctx, input);
  }

  /**
   * Which category section a listing belongs to. A section matches when any
   * of its rules does (`when` holds and `unless` does not); a listing that
   * two sections claim is ambiguous rather than given to whichever comes
   * first, so adding a category can never silently take listings from
   * another. Disabled sections take part: a listing in one is still known to
   * be in that category, and the caller skips it as not enabled.
   *
   * Public because both page and feed paths need exactly these semantics: a
   * shop that is both scraped and fed can then share its rules verbatim, and
   * `specValueIncludes` works against a feed's attribute pairs just as it
   * does against a page's spec table.
   */
  public resolveCategory(
    categories: Record<string, ProductSourceCategoryConfig> | undefined,
    rawLabel: string | undefined,
    rawSpecs: ScrapedProductSpec[] = [],
  ): CategoryResolution {
    const slugs = categoryRulesOf({ categories })
      .filter(({ rules }) =>
        rules.some(
          (rule) =>
            this.evaluateCondition(rule.when, rawLabel, rawSpecs) &&
            !(rule.unless && this.evaluateCondition(rule.unless, rawLabel, rawSpecs)),
        ),
      )
      .map(({ slug }) => slug);
    if (slugs.length === 1) return { status: 'resolved', slug: slugs[0] };
    return slugs.length ? { status: 'ambiguous', slugs } : { status: 'unidentified' };
  }

  /**
   * Parse ONE list page into its product cards.
   *
   * Deliberately has no power to enqueue anything: category expansion and
   * pagination are both resolved once, up front, by ScrapingImportService. That
   * is what makes the old re-emission bug — every page re-emitting the whole
   * page range — structurally impossible rather than merely guarded against.
   */
  public async runListPage(
    task: ProductImportTask,
    $: CheerioAPI,
    config: ScrapingSourceConfig,
  ): Promise<ListPageResult> {
    const ctx = this.makeContext(task, $, config);

    const categoryName = (await this.runner.run(
      config.listPage.categoryName,
      ctx,
    )) as string | undefined;

    const items = await this.runner.run(config.listPage.items, ctx);

    const products = ((await this.runner.run(
      [
        {
          op: 'forEachItem',
          itemMode: config.listPage.itemMode,
          itemPipeline: config.listPage.itemPipeline,
        },
      ],
      ctx,
      items,
    )) ?? []) as ScrapedListProduct[];

    return { categoryName, products };
  }

  public async runDetailPage(
    task: ProductImportTask,
    $: CheerioAPI,
    config: ScrapingSourceConfig,
  ): Promise<DetailPageResult> {
    const ctx = this.makeContext(task, $, config);

    // 1. raw specs first — category rules may need to inspect them.
    const rawSpecs =
      ((await this.runner.run(
        config.detailPage.rawSpecs,
        ctx,
      )) as ScrapedProductSpec[]) ?? [];
    ctx.vars['rawSpecs'] = rawSpecs;

    // 2. raw category label (breadcrumb text, etc.)
    const rawCategoryLabel = (await this.runner.run(
      config.detailPage.category.breadcrumbOrSource,
      ctx,
    )) as string | undefined;
    ctx.vars['categoryName'] = rawCategoryLabel;

    // Free-text marketing description, only run when configured — see
    // ProductSourceDetailPageConfig.description's doc comment.
    const description = config.detailPage.description
      ? ((await this.runner.run(
          config.detailPage.description,
          ctx,
        )) as string | undefined)
      : undefined;

    // 3. resolve the category from the sections' rules.
    const resolution = this.resolveCategory(config.categories, rawCategoryLabel, rawSpecs);
    const categorySlug = resolution.status === 'resolved' ? resolution.slug : undefined;

    // 4. brand/model/aliases/releaseYear/images — may reference vars.categoryName.
    // releaseYear here is a raw deterministic extraction, distinct from the
    // ProductModel.specs.modelYear it ultimately feeds — see
    // ProductDetailsPageScraperService, which folds it into deterministicSpecs.
    const brand = (await this.runner.run(
      config.detailPage.brand,
      ctx,
    )) as string | undefined;
    ctx.vars['brand'] = brand;

    const model = (await this.runner.run(
      config.detailPage.model,
      ctx,
    )) as string | undefined;
    ctx.vars['model'] = model;

    const aliases = config.detailPage.aliases
      ? ((await this.runner.run(
          config.detailPage.aliases,
          ctx,
        )) as string[] | undefined)
      : undefined;

    const releaseYear = config.detailPage.releaseYear
      ? ((await this.runner.run(
          config.detailPage.releaseYear,
          ctx,
        )) as number | undefined)
      : undefined;

    // Text, trimmed: a page's JSON can carry its id as a number, and the id
    // is the key of the listing's record.
    const externalId = config.detailPage.externalId
      ? this.toId(await this.runner.run(config.detailPage.externalId, ctx))
      : undefined;
    ctx.vars['externalId'] = externalId;

    const siblingIds = config.detailPage.siblingIds
      ? this.toIdList(await this.runner.run(config.detailPage.siblingIds, ctx))
      : undefined;

    const imageUrls =
      ((await this.runner.run(
        config.detailPage.images,
        ctx,
      )) as string[]) ?? [];

    const rawOffers = await this.runDetailPageOffers(ctx, config);

    const offerLinks = config.detailPage.offerLinks
      ? ((await this.runner.run(
          config.detailPage.offerLinks,
          ctx,
        )) as WebLink[] | undefined) ?? []
      : [];

    return {
      rawSpecs,
      description,
      categorySlug,
      ...(resolution.status === 'ambiguous' ? { ambiguousCategorySlugs: resolution.slugs } : {}),
      brand,
      model,
      aliases,
      releaseYear,
      externalId,
      siblingIds,
      imageUrls,
      rawOffers,
      offerLinks,
    };
  }

  // `offerList` gates whether this source populates offers at all (empty ->
  // opted out). Each entry is run through offersConfig.itemPipeline (which
  // must terminate in an assembleOffer op) via the forEachItem op, so a
  // source can expose either a single implicit offer (offerList resolving to
  // one item — the common single-seller-storefront case) or several (a true
  // multi-seller aggregator page).
  private async runDetailPageOffers(
    ctx: ScrapeExecutionContext,
    config: ScrapingSourceConfig,
  ): Promise<RawOfferRecord[]> {
    const offersConfig = config.detailPage.offers;
    if (!offersConfig || !offersConfig.offerList?.length) return [];

    const offerList = await this.runner.run(offersConfig.offerList, ctx);
    if (!offerList || (Array.isArray(offerList) && offerList.length === 0)) {
      return [];
    }

    const results = await this.runner.run(
      [
        {
          op: 'forEachItem',
          itemMode: offersConfig.itemMode,
          itemPipeline: offersConfig.itemPipeline,
        },
      ],
      ctx,
      offerList,
    );

    return (results as (RawOfferRecord | undefined)[]).filter(
      (r): r is RawOfferRecord => !!r,
    );
  }

  // A pipeline may end on a single id or a list, with numbers where the JSON
  // had them. Blank entries are dropped rather than kept as ids that match
  // nothing, and a list that comes out empty is reported as absent.
  private toId(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    return String(value).trim() || undefined;
  }

  private toIdList(value: unknown): string[] | undefined {
    const ids = (Array.isArray(value) ? value : [value])
      .filter((id) => typeof id === 'string' || typeof id === 'number')
      .map((id) => String(id).trim())
      .filter((id) => id !== '');
    return ids.length ? [...new Set(ids)] : undefined;
  }

  private evaluateCondition(
    condition: CategoryLookupCondition,
    rawLabel: string | undefined,
    rawSpecs: ScrapedProductSpec[],
  ): boolean {
    if ('always' in condition) {
      return true;
    }
    if ('equalsIgnoreCase' in condition) {
      return (
        (rawLabel ?? '').toLowerCase() ===
        condition.equalsIgnoreCase.toLowerCase()
      );
    }
    if ('specValueIncludes' in condition) {
      const spec = rawSpecs.find(
        (s) =>
          s.name.toLowerCase() ===
          condition.specValueIncludes.label.toLowerCase(),
      );
      const joined = (spec?.values ?? []).join(' ').toLowerCase();
      return condition.specValueIncludes.anyOf.some((keyword) =>
        joined.includes(keyword.toLowerCase()),
      );
    }
    if ('specSectionTitleIn' in condition) {
      const sectionTitles = rawSpecs
        .map((s) => s.sectionTitle?.toLowerCase().trim())
        .filter((title): title is string => !!title);
      const wanted = condition.specSectionTitleIn.map((t) => t.toLowerCase());
      return sectionTitles.some((title) => wanted.includes(title));
    }
    return false;
  }
}
