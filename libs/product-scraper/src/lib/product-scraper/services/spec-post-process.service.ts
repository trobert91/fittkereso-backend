import { Injectable } from '@nestjs/common';
import {
  ProductSourcePostProcessConfig,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductSpecs,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  DeterministicProductData,
  MergedProductData,
  ModelSpecContribution,
  OfferIdentityContribution,
  ProductSourcePostProcessMergeService,
  ProductSourcePostProcessService,
  ScrapedProductSpec,
} from '@fittkereso-backend/product';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';
import { CustomLogger } from '@fittkereso-backend/logger';
import { pick } from 'lodash';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';

// Guards the cross-sibling productSpecsHash lookup against two unrelated
// listings on the same source coincidentally sharing a sparse/near-empty
// (or fully empty) product-level deterministic specs object and wrongly
// sharing product-identity specs.
export const MIN_PRODUCT_SPEC_KEYS_FOR_SIBLING_REUSE = 3;

export interface SpecPostProcessParams {
  /** Who is importing and from where. The only thing the two callers differ in. */
  context: ProductImportContext;
  /** The source's post-process block, read from whichever config shape it has. */
  config: ProductSourcePostProcessConfig | undefined;
  data: DeterministicProductData;
  offerLevelDeterministicSpecs: ProductSpecs;
  productLevelDeterministicSpecs: ProductSpecs;
  rawSpecs: ScrapedProductSpec[];
  description?: string;
  productSpecsHash: string;
  jsonSchema: SpecDefinitionJsonSchema;
  categorySlug: string;
  /** The caller already compared offerSpecsHash and found it unchanged. */
  offerIdentitySameRecordHit: boolean;
  existingSource: ProductSourceRecord | undefined;
  existingOfferForSpecs: { specs?: ProductSpecs } | undefined;
  offerLevelKeys: string[];
}

/**
 * The LLM post-processing pass, and every way of avoiding paying for it.
 *
 * Extracted from ProductDetailsPageScraperService so the feed importer runs
 * exactly this code rather than a second copy of it. That matters more than it
 * looks: the skip decisions here are the cost control — a nightly pass over
 * speedbike's 3488 feed items would otherwise be ~7000 LLM calls — and two
 * implementations would drift on precisely the question of when a call is
 * skipped, which stays invisible until a bill arrives.
 *
 * Everything page-specific was pushed out to the callers. What is left takes a
 * ProductImportContext and an explicit post-process config, so it cannot tell
 * whether the product arrived as HTML or as a feed row.
 */
@Injectable()
export class SpecPostProcessService {
  private readonly logger = new CustomLogger(SpecPostProcessService.name);

  constructor(
    private readonly categoryConfigService: CategoryConfigService,
    private readonly postProcess: ProductSourcePostProcessService,
    private readonly postProcessMerge: ProductSourcePostProcessMergeService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
  ) {}

  public async resolve(
    params: SpecPostProcessParams,
  ): Promise<MergedProductData> {
    const {
      context,
      config,
      data,
      offerLevelDeterministicSpecs,
      productLevelDeterministicSpecs,
      rawSpecs,
      description,
      productSpecsHash,
      jsonSchema,
      categorySlug,
      offerIdentitySameRecordHit,
      existingSource,
      existingOfferForSpecs,
      offerLevelKeys,
    } = params;

    if (config?.enabled === false) {
      return this.postProcessMerge.merge(data, undefined, undefined);
    }

    const goldenSample =
      this.categoryConfigService.getGoldenSample(categorySlug);
    if (!goldenSample) {
      this.logger.warn(
        `Post-processing enabled for source '${context.source.name}' but category '${categorySlug}' has no golden sample, skipping`,
        this.logContext(context),
      );
      return this.postProcessMerge.merge(data, undefined, undefined);
    }

    const llmOptions = {
      model: config?.model,
      thinking: config?.thinking,
      effort: config?.effort,
      maxTokens: config?.maxTokens,
    };

    const offerIdentity = await this.getOfferIdentity({
      context,
      data,
      offerLevelDeterministicSpecs,
      description: config?.includeDescriptionInOfferIdentity
        ? description
        : undefined,
      schema: jsonSchema,
      goldenSample,
      offerLevelSpecs: offerLevelKeys,
      sameRecordHit: offerIdentitySameRecordHit,
      existingOfferForSpecs,
      llmOptions,
    });

    const modelSpecs = await this.getModelSpecs({
      context,
      data,
      productLevelDeterministicSpecs,
      rawSpecs,
      description:
        config?.includeDescriptionInModelSpecs === false
          ? undefined
          : description,
      productSpecsHash,
      schema: jsonSchema,
      goldenSample,
      offerLevelSpecs: offerLevelKeys,
      existingSource,
      llmOptions,
    });

    return this.postProcessMerge.merge(data, offerIdentity, modelSpecs);
  }

  // Always resolves to *something* usable — either a same-record reuse (no
  // LLM call) or a fresh processOfferIdentity call. This half's output is
  // inherently listing-specific (its own title/size/color) and is never looked
  // up from a sibling the way getModelSpecs's product-identity half is; the
  // only reuse this half supports is the same listing seen again unchanged. No
  // raw spec rows are sent to this call at all — its input is just the raw
  // title/model text plus offerLevelDeterministicSpecs, the already-mapped
  // offer-level subset of the deterministic pass.
  private async getOfferIdentity(params: {
    context: ProductImportContext;
    data: DeterministicProductData;
    offerLevelDeterministicSpecs: ProductSpecs;
    description?: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    sameRecordHit: boolean;
    existingOfferForSpecs: { specs?: ProductSpecs } | undefined;
    llmOptions: {
      model?: string;
      thinking?: boolean;
      effort?: string;
      maxTokens?: number;
    };
  }): Promise<OfferIdentityContribution | undefined> {
    const {
      context,
      data,
      offerLevelDeterministicSpecs,
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
      sameRecordHit,
      existingOfferForSpecs,
      llmOptions,
    } = params;

    if (sameRecordHit) {
      // No fresh offer-identity contribution this pass — the persisted
      // listing's own offer-level specs (recovered from its Offer row, since
      // they are stripped before landing on scrapedProduct.specs) are the
      // closest equivalent to "what processOfferIdentity would have said."
      return { specs: pick(existingOfferForSpecs?.specs, offerLevelSpecs) };
    }

    this.logger.debug('Running offer-identity LLM call', {
      ...this.logContext(context),
      offerLevelKeyCount: Object.keys(offerLevelDeterministicSpecs).length,
    });

    return this.postProcess.processOfferIdentity({
      data: {
        brand: data.brand,
        model: data.model,
        specs: offerLevelDeterministicSpecs,
      },
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
      ...llmOptions,
    });
  }

  // The expensive, reasoning-heavy half. Checks (in order): same-record hash
  // match (data already in hand from the caller, no extra query), then a
  // cross-sibling productSpecsHash match (a different ProductSourceRecord on
  // the same source whose product-identity deterministic specs were
  // identical), and only calls the LLM when both miss.
  private async getModelSpecs(params: {
    context: ProductImportContext;
    data: DeterministicProductData;
    productLevelDeterministicSpecs: ProductSpecs;
    rawSpecs: ScrapedProductSpec[];
    description?: string;
    productSpecsHash: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    existingSource: ProductSourceRecord | undefined;
    llmOptions: {
      model?: string;
      thinking?: boolean;
      effort?: string;
      maxTokens?: number;
    };
  }): Promise<ModelSpecContribution | undefined> {
    const {
      context,
      data,
      productLevelDeterministicSpecs,
      rawSpecs,
      description,
      productSpecsHash,
      schema,
      goldenSample,
      offerLevelSpecs,
      existingSource,
      llmOptions,
    } = params;

    if (
      existingSource?.productSpecsHash === productSpecsHash &&
      !context.force
    ) {
      // Same-record hit — already logged/metered by the caller, which computed
      // this comparison first. Reuse this record's own already-persisted
      // product-identity specs.
      return {
        specs:
          existingSource.scrapedProduct?.productLevelDeterministicSpecs ?? {},
      };
    }

    if (
      !context.force &&
      Object.keys(productLevelDeterministicSpecs).length >=
        MIN_PRODUCT_SPEC_KEYS_FOR_SIBLING_REUSE
    ) {
      const sibling =
        await this.sourceRecordRepo.findBySourceAndProductSpecsHash(
          context.source.id,
          productSpecsHash,
        );
      if (
        sibling?.scrapedProduct?.productLevelDeterministicSpecs !== undefined
      ) {
        this.logger.debug(
          'Product specs match a sibling source record, reusing its unified model-level specs',
          {
            ...this.logContext(context),
            productSpecsHash,
            siblingSourceId: sibling.id,
            siblingUrl: sibling.url,
            siblingLastUpdated: sibling.lastUpdated,
          },
        );
        this.scrapingMetrics.recordExtractionSkipReason(
          context.source.name,
          'product_specs_matched_sibling',
        );
        return { specs: sibling.scrapedProduct.productLevelDeterministicSpecs };
      }
    }

    this.logger.debug('Running model-spec LLM call', {
      ...this.logContext(context),
      productSpecsHash,
      productLevelKeyCount: Object.keys(productLevelDeterministicSpecs).length,
    });

    return this.postProcess.processModelSpecs({
      data: { ...data, specs: productLevelDeterministicSpecs },
      rawSpecs,
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
      ...llmOptions,
    });
  }

  /** `taskId` is present on the scrape path only, and absent on a feed run. */
  private logContext(context: ProductImportContext): Record<string, unknown> {
    return { taskId: context.task?.id, url: context.url };
  }
}
