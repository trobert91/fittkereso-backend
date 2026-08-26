import { Injectable } from '@nestjs/common';
import type { CheerioAPI } from 'cheerio';
import {
  CategoryLookupCondition,
  ProductSourceConfig,
  ProductSpecs,
  ScrapeQueueName,
  ScrapeTask,
} from '@fittkereso-backend/database';
import { ScrapedProductSpec, WebLink } from '@fittkereso-backend/product';
import { ScrapePipelineRunnerService } from './services/scrape-pipeline-runner.service';
import { RuntimeDataProviderService } from './services/runtime-data-provider.service';
import { ScrapeExecutionContext } from './interfaces/scrape-execution-context.interface';

export interface ListPageResult {
  categoryName?: string;
  categoryLinks: WebLink[];
  productLinks: WebLink[];
}

export interface RawOfferRecord {
  price?: number;
  priceWithoutDiscount?: number;
  currency?: string;
  availability?: string;
  url?: string;
  externalId?: string;
  locations?: string[];
  specs?: ProductSpecs;
}

export interface DetailPageResult {
  rawSpecs: ScrapedProductSpec[];
  categorySlug: string | undefined;
  brand: string | undefined;
  model: string | undefined;
  aliases?: string[];
  releaseYear?: number;
  externalId?: string;
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
    task: ScrapeTask,
    $: CheerioAPI,
    config: ProductSourceConfig,
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

  public async runListPage(
    task: ScrapeTask,
    $: CheerioAPI,
    config: ProductSourceConfig,
  ): Promise<ListPageResult> {
    const ctx = this.makeContext(task, $, config);

    const categoryName = (await this.runner.run(
      config.listPage.categoryName,
      ctx,
    )) as string | undefined;

    const categoryLinks =
      ((await this.runner.run(
        config.listPage.categoryLinks,
        ctx,
      )) as WebLink[]) ?? [];

    const productLinks =
      ((await this.runner.run(
        config.listPage.productLinks,
        ctx,
      )) as WebLink[]) ?? [];

    return { categoryName, categoryLinks, productLinks };
  }

  public async runDetailPage(
    task: ScrapeTask,
    $: CheerioAPI,
    config: ProductSourceConfig,
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

    // 3. resolve category slug via declarative lookup rules, first match wins.
    const categorySlug = this.resolveCategorySlug(
      config.detailPage.category.slugLookup,
      rawCategoryLabel,
      rawSpecs,
    );

    // 4. brand/model/aliases/releaseYear/images — may reference vars.categoryName.
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

    const externalId = config.detailPage.externalId
      ? ((await this.runner.run(
          config.detailPage.externalId,
          ctx,
        )) as string | undefined)
      : undefined;
    ctx.vars['externalId'] = externalId;

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
      categorySlug,
      brand,
      model,
      aliases,
      releaseYear,
      externalId,
      imageUrls,
      rawOffers,
      offerLinks,
    };
  }

  public async runDiscovery(
    task: ScrapeTask,
    $: CheerioAPI,
    config: ProductSourceConfig,
    opts: { sourceTitles?: string[]; brandNames?: string[] } = {},
  ): Promise<WebLink[]> {
    if (!config.discovery) return [];

    const ctx = this.makeContext(task, $, config, {
      sourceTitles: opts.sourceTitles ?? [],
      brandNames: opts.brandNames ?? [],
    });

    return (
      ((await this.runner.run(
        config.discovery.linkPipeline,
        ctx,
      )) as WebLink[]) ?? []
    );
  }

  public classifyIncrementalUrl(
    url: string,
    config: ProductSourceConfig,
  ): { queue: ScrapeQueueName; url: string } | null {
    const pattern = config.incrementalSync?.urlClassify?.detailUrlPattern;
    if (!pattern) return null;

    const regex = new RegExp(pattern);
    if (regex.test(url)) {
      return { queue: ScrapeQueueName.ScrapeProductDetails, url };
    }
    return null;
  }

  // `offerList` gates whether this source populates offers at all (empty ->
  // opted out). Each entry is run through offersConfig.itemPipeline (which
  // must terminate in an assembleOffer op) via the forEachItem op, so a
  // source can expose either a single implicit offer (offerList resolving to
  // one item — the common single-seller-storefront case) or several (a true
  // multi-seller aggregator page).
  private async runDetailPageOffers(
    ctx: ScrapeExecutionContext,
    config: ProductSourceConfig,
  ): Promise<RawOfferRecord[]> {
    const offersConfig = config.detailPage.offers;
    if (!offersConfig || offersConfig.offerList.length === 0) return [];

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

  private resolveCategorySlug(
    rules: { when: CategoryLookupCondition; slug: string; unless?: CategoryLookupCondition }[],
    rawLabel: string | undefined,
    rawSpecs: ScrapedProductSpec[],
  ): string | undefined {
    for (const rule of rules) {
      if (!this.evaluateCondition(rule.when, rawLabel, rawSpecs)) continue;
      if (rule.unless && this.evaluateCondition(rule.unless, rawLabel, rawSpecs)) {
        continue;
      }
      return rule.slug;
    }
    return undefined;
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
