import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  OfferAvailability,
  ProductCategory,
  ProductSource,
  ScrapedProduct,
  ScrapingSourceConfig,
  ProductImportTask,
  SourceSpecConfig,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BrandResolutionService,
  ScrapedOffer,
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
import { isEqual, omitBy, pick } from 'lodash';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';
import { splitDeterministicSpecs } from './deterministic-specs';
import { SpecPostProcessService } from './spec-post-process.service';
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
  model: string;
  displayName: string;
  originalName?: string;
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
   * declared siblings, and how many spec rows identityExtraction.specRows
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
    /** The identity fields after the identity extraction (deterministic values merged in). */
    identity: Record<string, unknown>;
    /** What full spec unification added or corrected on top of that. */
    unification: Record<string, unknown>;
    /** Everything a product created from this page would carry. */
    merged: Record<string, unknown>;
  };
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
    private readonly scraperService: ScraperService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly runtime: RuntimeDataProviderService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly specExtraction: SpecExtractionService,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly translationSelector: SpecTranslationSelectorService,
    private readonly translationService: TranslationService,
    private readonly brandResolution: BrandResolutionService,
  ) {}

  public async simulateDetailPageScrape(
    url: string,
    config: ScrapingSourceConfig,
  ): Promise<ProductSourceSimulationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    const html = await this.scraperService.getHtml(url);
    const $ = cheerio.load(html);

    const task = this.buildFakeTask(url, config);
    const detail = await this.interpreter.runDetailPage(task, $, config);

    const result: ProductSourceSimulationResult = {
      url,
      html: { length: html.length },
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
          specRows: config.identityExtraction?.specRows,
        }),
      ),
      warnings,
      errors,
    };

    if (!detail.categorySlug) {
      errors.push(
        'Category could not be identified (detailPage.category.slugLookup matched no rule) — the real pipeline would abort product creation here.',
      );
      return result;
    }

    const categoryEnabled = config.categories?.[detail.categorySlug]?.enabled ?? false;
    const category = await this.tryGetCategory(detail.categorySlug);

    result.category = {
      slug: detail.categorySlug,
      found: !!category,
      enabled: categoryEnabled,
      hasJsonSchema: !!this.categoryConfigService.getJsonSchema(detail.categorySlug),
    };

    if (!category) {
      errors.push(
        `Category slug "${detail.categorySlug}" was resolved by slugLookup but does not exist in the database — the real pipeline would abort product creation here.`,
      );
      return result;
    }
    if (!categoryEnabled) {
      warnings.push(
        `Category "${detail.categorySlug}" is not enabled in config.categories — the real pipeline would skip product creation (no error, just a silent skip) for this page.`,
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

    const sourceConfig = config.detailPage.specMapping[category.slug];
    if (!sourceConfig) {
      warnings.push(
        `No detailPage.specMapping entry for category "${category.slug}" — deterministic spec extraction will produce an empty object.`,
      );
    }

    const translator = await this.buildTranslator(
      config,
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
    // Mirrors ProductDetailsPageScraperService: detailPage.releaseYear is a
    // dedicated deterministic scrape-op, folded into modelYear so this
    // preview matches what the real pipeline would persist to specs.
    if (deterministicSpecs['modelYear'] === undefined && detail.releaseYear !== undefined) {
      deterministicSpecs['modelYear'] = detail.releaseYear;
    }

    const offerLevelKeys =
      this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs ?? [];
    const split = splitDeterministicSpecs(deterministicSpecs, offerLevelKeys);
    // The same deterministic listing ProductDetailsPageScraperService hands
    // the updater.
    const listing: ScrapedProduct = {
      brand: detail.brand,
      model: detail.model,
      displayName: `${detail.brand} ${detail.model}`.trim(),
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
      offers: this.toScrapedOffers(detail.rawOffers),
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
    if (config.detailPage.postProcess?.enabled !== false && !identified.nameCleaned) {
      warnings.push(
        'The identity extraction ran but contributed nothing usable (LLM call failed, hit the token ceiling, or returned nothing confident) — the real pipeline would continue on the deterministic specs and the raw title.',
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

    const brandMatch = await this.brandResolution.resolve(
      identified.brand,
      identified.displayName,
    );
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
      displayName: identified.displayName,
      originalName: detail.model,
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

  private async tryGetCategory(slug: string): Promise<ProductCategory | undefined> {
    return (await this.runtime.getCategoryBySlug(slug)) ?? undefined;
  }

  private buildFakeTask(url: string, config: ScrapingSourceConfig): ProductImportTask {
    // Only `task.url` is read by the interpreter ops (see link-ops buildBaseUrl);
    // task.force/task.source/task.product are irrelevant here since we never
    // call ProductScrapeUpdaterService. Cast rather than constructing a real
    // ProductImportTask entity — this object is never persisted or passed to a
    // repository.
    return {
      url,
      force: true,
      source: { name: 'simulation', config },
    } as unknown as ProductImportTask;
  }

  private toScrapedOffers(rawOffers: RawOfferRecord[]): ScrapedOffer[] {
    return rawOffers
      .filter(
        (offer): offer is RawOfferRecord & { price: number } =>
          typeof offer.price === 'number' && Number.isFinite(offer.price),
      )
      .map((offer) => ({
        price: offer.price,
        priceWithoutDiscount: offer.priceWithoutDiscount,
        currency: offer.currency,
        availability: this.parseAvailability(offer.availability),
        url: offer.url,
        externalId: offer.externalId,
        gtin: offer.gtin,
        mpn: offer.mpn,
        locations: offer.locations,
      }));
  }

  private parseAvailability(value: string | undefined): OfferAvailability | undefined {
    return value && (Object.values(OfferAvailability) as string[]).includes(value)
      ? (value as OfferAvailability)
      : undefined;
  }

  private async buildTranslator(
    config: ScrapingSourceConfig,
    rawSpecs: ScrapedProductSpec[],
    sourceConfig: SourceSpecConfig | undefined,
    categoryName: string,
  ) {
    const translationConfig = config.detailPage.translation;
    if (!translationConfig?.enabled) {
      return undefined;
    }

    const rawValues = this.translationSelector.collectTranslatableValues(rawSpecs, sourceConfig);
    if (rawValues.length === 0) {
      return undefined;
    }

    const context = translationConfig.contextTemplate.replace(/\{\{\s*categoryName\s*\}\}/g, categoryName);

    const { lookup } = await this.translationService.translateBatch({
      texts: rawValues,
      sourceLanguage: translationConfig.sourceLanguage,
      targetLanguage: translationConfig.targetLanguage,
      context,
    });

    return lookup;
  }
}
