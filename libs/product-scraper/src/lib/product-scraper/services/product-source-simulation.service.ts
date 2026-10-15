import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductSource,
  ProductSourceFetchMode,
  ScrapedProduct,
  ScrapedProductFlag,
  ProductImportTask,
  categorySectionOf,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BrandResolutionService,
  ScrapedOffer,
  ScrapedProductSpec,
} from '@fittkereso-backend/product';
import {
  DetailPageSourceConfig,
  RawOfferRecord,
  RuntimeDataProviderService,
} from '@fittkereso-backend/scrape-interpreter';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';
import { PageInterpretation, ProductPageReaderService } from './product-page-reader.service';
import { isEqual, omitBy, pick } from 'lodash';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';
import {
  foldBrandIdentifierSpecs,
  foldReleaseYear,
  splitDeterministicSpecs,
} from './deterministic-specs';
import { SpecPostProcessService } from './spec-post-process.service';
import { toScrapedOffers } from './scraped-offers';
import {
  previewListingIdentifiers,
  SimulatedListingIdentifiers,
} from './identifier-preview';

export interface SimulatedBrandResolution {
  queriedName: string | undefined;
  matched: boolean;
  resolvedName?: string;
  similarity?: number;
}

export interface SimulatedProductPreview {
  brand: string;
  /** Absent when the identity extraction gave no name (see `flags`). */
  model?: string;
  /** The model normalized: what name matching keys this listing on. */
  normalizedModel?: string;
  originalName?: string;
  flags?: ScrapedProductFlag[];
  categorySlug: string;
  categoryName: string;
  aliases?: string[];
  specs: Record<string, unknown>;
  externalId?: string;
  imageUrls: string[];
  offers: ScrapedOffer[];
}

export interface ProductSourceSimulationResult {
  url: string;
  fetchMode: ProductSourceFetchMode;
  html: {
    length: number;
  };
  extraction: {
    rawSpecs: ScrapedProductSpec[];
    brand?: string;
    model?: string;
    aliases?: string[];
    releaseYear?: number;
    externalId?: string;
    siblingIds?: string[];
    imageUrls: string[];
    rawOffers: RawOfferRecord[];
  };
  /**
   * Per offer: the GTIN/MPN as published and as they would be stored, the
   * declared siblings, and how many spec rows the category section's identitySpecRows
   * lets through — everything identity resolution looks up before any LLM.
   */
  identifiers: SimulatedListingIdentifiers[];
  category?: {
    slug: string;
    found: boolean;
    enabled: boolean;
    hasJsonSchema: boolean;
  };
  specs?: {
    deterministic: Record<string, unknown>;
    /**
     * The identity fields after the identity extraction (deterministic values
     * merged in). Absent for a feed's page, which only fills its rows' gaps.
     */
    identity?: Record<string, unknown>;
    /** What full spec unification added or corrected on top of that. */
    unification?: Record<string, unknown>;
    /** Everything a product created from this page would carry. */
    merged?: Record<string, unknown>;
  };
  /**
   * Set for a feed source's page: the category its rows map it for. The page
   * fills what a row lacks; category, price and stock, and every value the row
   * has, stay the feed's (simulate_product_source_import previews the merge).
   */
  feedPage?: { categorySlug: string };
  brandResolution?: SimulatedBrandResolution;
  productPreview?: SimulatedProductPreview;
  warnings: string[];
  errors: string[];
}

/**
 * Dry-run of the product-detail scrape pipeline for validating a
 * ProductSourceConfig against a real URL: fetches the page, runs the same
 * interpreter/spec-extraction/post-process/brand-resolution steps as
 * ProductDetailsPageScraperService, and previews the resulting product model
 * shape — without persisting anything (no ProductModel/Offer/ProductSourceRecord
 * writes, no brand creation, no image copying). Intended for use ahead of
 * saving a ProductSource config, so a config can be iterated on against real
 * pages before being applied via update_product_source.
 */
@Injectable()
export class ProductSourceSimulationService {
  constructor(
    private readonly pageReader: ProductPageReaderService,
    private readonly runtime: RuntimeDataProviderService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly brandResolution: BrandResolutionService,
    private readonly matchQuery: ProductMatchQueryService,
  ) {}

  /**
   * `fetchMode` is the one the page is fetched in, resolved by the caller:
   * the tool's argument, else `detailPage.fetchMode`, else the source's.
   *
   * A feed source's page (`feedCategorySlug` set) is read as its page task
   * reads it, for the category its rows bring: its rows mapped onto that
   * category's specs, and nothing more — no identity extraction or brand,
   * which a feed row's own values decide.
   */
  public async simulateDetailPageScrape(
    url: string,
    config: DetailPageSourceConfig,
    fetchMode: ProductSourceFetchMode,
    feedCategorySlug?: string,
  ): Promise<ProductSourceSimulationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const feedCategory = feedCategorySlug ? await this.tryGetCategory(feedCategorySlug) : undefined;
    if (feedCategorySlug && !feedCategory) {
      throw new Error(`No category "${feedCategorySlug}" in the database`);
    }

    const pageConfig: DetailPageSourceConfig = {
      ...config,
      detailPage: { ...config.detailPage, fetchMode },
    };
    const task = this.buildFakeTask(url, pageConfig, fetchMode);
    const interpretation = await this.pageReader.interpret({
      task,
      config: pageConfig,
      category: feedCategory
        ? { id: feedCategory.id, slug: feedCategory.slug, name: feedCategory.name }
        : undefined,
    });
    const { detail } = interpretation;

    const result: ProductSourceSimulationResult = {
      url,
      fetchMode,
      html: { length: interpretation.htmlLength },
      extraction: {
        rawSpecs: detail.rawSpecs,
        brand: detail.brand,
        model: detail.model,
        aliases: detail.aliases,
        releaseYear: detail.releaseYear,
        externalId: detail.externalId,
        siblingIds: detail.siblingIds,
        imageUrls: detail.imageUrls,
        rawOffers: detail.rawOffers,
      },
      identifiers: detail.rawOffers.map((offer) =>
        previewListingIdentifiers({
          externalId: offer.externalId,
          gtin: offer.gtin,
          mpn: offer.mpn,
          siblingIds: detail.siblingIds,
          rawSpecs: detail.rawSpecs,
          specRows: categorySectionOf(config, feedCategory?.slug ?? detail.categorySlug)
            ?.identitySpecRows,
        }),
      ),
      warnings,
      errors,
    };

    if (feedCategory) {
      return this.feedPageResult(result, task, pageConfig, interpretation, feedCategory.slug);
    }

    const problem = interpretation.categoryProblem;
    if (problem?.reason === 'ambiguous') {
      errors.push(
        `Category is ambiguous: the rules of ${problem.slugs.join(', ')} all match — the real pipeline would abort product creation here.`,
      );
      return result;
    }

    const slug = interpretation.category?.slug ?? (problem && 'slug' in problem ? problem.slug : undefined);
    if (!slug) {
      errors.push(
        "Category could not be identified (no category section's rules matched) — the real pipeline would abort product creation here.",
      );
      return result;
    }

    const categoryEnabled = categorySectionOf(config, slug)?.enabled ?? false;
    const category = await this.tryGetCategory(slug);

    result.category = {
      slug,
      found: !!category,
      enabled: categoryEnabled,
      hasJsonSchema: !!this.categoryConfigService.getJsonSchema(slug),
    };

    if (!category) {
      errors.push(
        `Category slug "${slug}" was resolved by its section's rules but does not exist in the database — the real pipeline would abort product creation here.`,
      );
      return result;
    }
    if (!categoryEnabled) {
      warnings.push(
        `Category "${slug}" is not enabled in its config.categories section — the real pipeline would skip product creation (no error, just a silent skip) for this page.`,
      );
    }

    const jsonSchema = this.categoryConfigService.getJsonSchema(category.slug);
    if (!jsonSchema) {
      errors.push(
        `Category "${category.slug}" has no associated JSON schema on disk (libs/config categories) — the real pipeline would abort product creation here.`,
      );
      return result;
    }

    if (!detail.brand || !detail.model) {
      errors.push(
        `Missing required ${!detail.brand ? 'brand' : ''}${!detail.brand && !detail.model ? ' and ' : ''}${!detail.model ? 'model' : ''} — the real pipeline would skip product creation for this page.`,
      );
      return result;
    }

    const sourceConfig = categorySectionOf(config, category.slug)?.specMapping;
    if (!sourceConfig) {
      warnings.push(
        `No specMapping in the "${category.slug}" category section — deterministic spec extraction will produce an empty object.`,
      );
    }

    const categoryConfig = this.categoryConfigService.getConfig(category.slug);
    const offerLevelKeys = categoryConfig?.offerLevelSpecs ?? [];
    // Mapped by the reader, as a real scrape maps them — also for a category
    // not enabled, which the reader alone would stop at.
    const deterministicSpecs = await this.pageReader.mapSpecs({
      task,
      config: pageConfig,
      interpretation: {
        ...interpretation,
        category: { id: category.id, slug: category.slug, name: category.name },
        schema: jsonSchema,
        categoryProblem: undefined,
      },
    });
    // As ProductDetailsPageScraperService does, so this preview matches what
    // the real pipeline would persist to specs.
    foldReleaseYear(deterministicSpecs, detail.releaseYear);
    const offers = toScrapedOffers(detail.rawOffers);
    foldBrandIdentifierSpecs(
      deterministicSpecs,
      { brand: detail.brand, offers },
      categoryConfig?.brandIdentifierSpecs,
      jsonSchema,
    );

    const split = splitDeterministicSpecs(deterministicSpecs, offerLevelKeys);
    // The same deterministic listing ProductDetailsPageScraperService hands
    // the updater.
    const listing: ScrapedProduct = {
      brand: detail.brand,
      originalName: detail.model,
      category: { id: category.id, slug: category.slug, name: category.name },
      specs: split.productLevelDeterministicSpecs,
      extractedSpecs: deterministicSpecs,
      ...split,
      rawSpecs: detail.rawSpecs,
      description: detail.description,
      externalId: detail.externalId,
      siblingExternalIds: detail.siblingIds,
      aliases: detail.aliases,
      offers,
    };

    // Both calls a real import makes for a page that creates a product, run
    // unconditionally: a simulation previews what extraction produces for this
    // page, not what a re-import would reuse. `force` rules out any reuse.
    const context: ProductImportContext = {
      source: { name: 'simulation', config } as ProductSource,
      url,
      force: true,
    };
    const identified = await this.specPostProcess.extractIdentity({
      context,
      scrapedProduct: listing,
    });
    if (identified.flags?.includes('identity_failed')) {
      warnings.push(
        'The identity extraction ran but returned no model name (LLM call failed, hit the token ceiling, or returned nothing confident) — the real pipeline would continue on the deterministic specs, match on the raw title, and ask again on the next import.',
      );
    }
    const unified = await this.specPostProcess.unify({
      context,
      scrapedProduct: identified,
      trigger: 'created',
    });

    const scopes = this.specPostProcess.scopesOf(category.slug, jsonSchema);
    const pageOfferLevelSpecs = identified.offers?.[0]?.specs ?? {};
    const identitySpecs = { ...identified.specs, ...pageOfferLevelSpecs };
    const mergedSpecs = { ...unified.specs, ...pageOfferLevelSpecs };
    result.specs = {
      deterministic: deterministicSpecs,
      identity: pick(identitySpecs, scopes.identityKeys),
      unification: omitBy(unified.specs ?? {}, (value, key) =>
        isEqual(value, identified.specs?.[key]),
      ),
      merged: mergedSpecs,
    };

    const brandMatch = await this.brandResolution.resolve(identified.brand, identified.originalName);
    result.brandResolution = {
      queriedName: identified.brand,
      matched: !!brandMatch?.entity,
      resolvedName: brandMatch?.entity?.name,
      similarity: brandMatch?.similarity,
    };
    if (!brandMatch?.entity) {
      errors.push(
        `Brand "${identified.brand}" could not be resolved against existing brands (no alias/trigram match >= 0.8) — the real pipeline would skip product creation for this page (unless a new Brand is created for it out of band).`,
      );
    }

    result.productPreview = {
      brand: identified.brand,
      model: identified.model,
      normalizedModel: this.matchQuery.normalizedModelOf(identified),
      originalName: detail.model,
      flags: identified.flags,
      categorySlug: category.slug,
      categoryName: category.name,
      aliases: detail.aliases,
      specs: mergedSpecs,
      externalId: detail.externalId,
      imageUrls: detail.imageUrls,
      offers: identified.offers ?? [],
    };

    return result;
  }

  /**
   * A feed source's page, read for its rows' category: what its rows map to.
   * A feed row brings its own category, brand, title, price and stock, so
   * nothing else is asked of the page.
   */
  private async feedPageResult(
    result: ProductSourceSimulationResult,
    task: ProductImportTask,
    config: DetailPageSourceConfig,
    interpretation: PageInterpretation,
    slug: string,
  ): Promise<ProductSourceSimulationResult> {
    result.feedPage = { categorySlug: slug };
    result.category = {
      slug,
      found: true,
      enabled: categorySectionOf(config, slug)?.enabled ?? false,
      hasJsonSchema: !!interpretation.schema,
    };
    if (interpretation.categoryProblem) {
      result.errors.push(
        `Category "${slug}" has no associated JSON schema on disk (libs/config categories) — a page import could not map its rows.`,
      );
      return result;
    }
    if (!categorySectionOf(config, slug)?.specMapping) {
      result.warnings.push(
        `No specMapping in the "${slug}" category section — the page's rows would map to no spec. Add the page's labels there, beside the feed's.`,
      );
    }
    result.specs = {
      deterministic: await this.pageReader.mapSpecs({ task, config, interpretation }),
    };
    return result;
  }

  private async tryGetCategory(slug: string): Promise<ProductCategory | undefined> {
    return (await this.runtime.getCategoryBySlug(slug)) ?? undefined;
  }

  private buildFakeTask(
    url: string,
    config: DetailPageSourceConfig,
    fetchMode: ProductSourceFetchMode,
  ): ProductImportTask {
    // The interpreter ops read `task.url` (see link-ops buildBaseUrl), the
    // reader the source's name and mode. Nothing reaches
    // ProductScrapeUpdaterService. Cast rather than constructing a real
    // ProductImportTask entity — this object is never persisted or passed to a
    // repository.
    return {
      url,
      force: true,
      source: { name: 'simulation', fetchMode, config },
    } as unknown as ProductImportTask;
  }
}
