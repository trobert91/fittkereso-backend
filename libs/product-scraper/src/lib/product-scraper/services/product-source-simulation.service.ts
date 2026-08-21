import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  OfferAvailability,
  ProductCategory,
  ProductSourceConfig,
  ScrapeTask,
  SourceSpecConfig,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BrandResolutionService,
  DeterministicProductData,
  ProductSourcePostProcessMergeService,
  ProductSourcePostProcessService,
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
  categorySlug: string;
  categoryName: string;
  aliases?: string[];
  releaseYear?: number;
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
    imageUrls: string[];
    rawOffers: RawOfferRecord[];
  };
  category?: {
    slug: string;
    found: boolean;
    enabled: boolean;
    hasJsonSchema: boolean;
  };
  specs?: {
    deterministic: Record<string, unknown>;
    llmContribution?: Record<string, unknown>;
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
    private readonly postProcess: ProductSourcePostProcessService,
    private readonly postProcessMerge: ProductSourcePostProcessMergeService,
    private readonly translationSelector: SpecTranslationSelectorService,
    private readonly translationService: TranslationService,
    private readonly brandResolution: BrandResolutionService,
  ) {}

  public async simulateDetailPageScrape(
    url: string,
    config: ProductSourceConfig,
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
        imageUrls: detail.imageUrls,
        rawOffers: detail.rawOffers,
      },
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

    const deterministicData: DeterministicProductData = {
      brand: detail.brand,
      model: detail.model,
      specs: deterministicSpecs,
      releaseYear: detail.releaseYear,
    };

    const postProcessConfig = config.detailPage.postProcess;
    let llmContribution: Record<string, unknown> | undefined;
    let merged = deterministicData;

    if (postProcessConfig?.enabled) {
      const goldenSample = this.categoryConfigService.getGoldenSample(category.slug);
      if (!goldenSample) {
        warnings.push(
          `Post-processing is enabled but category "${category.slug}" has no golden sample — the real pipeline would silently skip post-processing and use deterministic specs only.`,
        );
        merged = this.postProcessMerge.merge(deterministicData, undefined);
      } else {
        const offerLevelSpecs = this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs;
        const llmResult = await this.postProcess.process({
          data: deterministicData,
          rawSpecs: detail.rawSpecs,
          schema: jsonSchema,
          goldenSample,
          model: postProcessConfig.model,
          thinking: postProcessConfig.thinking,
          effort: postProcessConfig.effort,
          maxTokens: postProcessConfig.maxTokens,
          offerLevelSpecs,
        });
        if (!llmResult) {
          warnings.push(
            'Post-processing ran but contributed nothing usable (LLM call failed, hit the token ceiling, or returned no confident fields) — degraded to deterministic specs only.',
          );
        }
        llmContribution = llmResult as Record<string, unknown> | undefined;
        merged = this.postProcessMerge.merge(deterministicData, llmResult);
      }
    }

    result.specs = {
      deterministic: deterministicSpecs,
      llmContribution,
      merged: merged.specs,
    };

    const brandMatch = await this.brandResolution.resolve(merged.brand, `${merged.brand} ${merged.model}`.trim());
    result.brandResolution = {
      queriedName: merged.brand,
      matched: !!brandMatch?.entity,
      resolvedName: brandMatch?.entity?.name,
      similarity: brandMatch?.similarity,
    };
    if (!brandMatch?.entity) {
      errors.push(
        `Brand "${merged.brand}" could not be resolved against existing brands (no alias/trigram match >= 0.8) — the real pipeline would skip product creation for this page (unless a new Brand is created for it out of band).`,
      );
    }

    result.productPreview = {
      brand: merged.brand,
      model: merged.model,
      displayName: `${merged.brand} ${merged.model}`.trim(),
      categorySlug: category.slug,
      categoryName: category.name,
      aliases: detail.aliases,
      releaseYear: merged.releaseYear,
      specs: merged.specs,
      externalId: detail.externalId,
      imageUrls: detail.imageUrls,
      offers: this.toScrapedOffers(detail.rawOffers),
    };

    return result;
  }

  private async tryGetCategory(slug: string): Promise<ProductCategory | undefined> {
    return (await this.runtime.getCategoryBySlug(slug)) ?? undefined;
  }

  private buildFakeTask(url: string, config: ProductSourceConfig): ScrapeTask {
    // Only `task.url` is read by the interpreter ops (see link-ops buildBaseUrl);
    // task.force/task.source/task.product are irrelevant here since we never
    // call ProductScrapeUpdaterService. Cast rather than constructing a real
    // ScrapeTask entity — this object is never persisted or passed to a
    // repository.
    return {
      url,
      force: true,
      source: { name: 'simulation', config },
    } as unknown as ScrapeTask;
  }

  private toScrapedOffers(rawOffers: RawOfferRecord[]): ScrapedOffer[] {
    return rawOffers
      .filter(
        (offer): offer is RawOfferRecord & { sellerName: string; price: number } =>
          !!offer.sellerName && typeof offer.price === 'number' && Number.isFinite(offer.price),
      )
      .map((offer) => ({
        sellerName: offer.sellerName,
        price: offer.price,
        priceWithoutDiscount: offer.priceWithoutDiscount,
        currency: offer.currency,
        availability: this.parseAvailability(offer.availability),
        url: offer.url,
        sourceListingId: offer.sourceListingId,
      }));
  }

  private parseAvailability(value: string | undefined): OfferAvailability | undefined {
    return value && (Object.values(OfferAvailability) as string[]).includes(value)
      ? (value as OfferAvailability)
      : undefined;
  }

  private async buildTranslator(
    config: ProductSourceConfig,
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
