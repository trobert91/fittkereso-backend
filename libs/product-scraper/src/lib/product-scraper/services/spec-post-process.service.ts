import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  isArukeresoConfig,
  isScrapingConfig,
  ProductSourceConfig,
  ProductSourcePostProcessConfig,
  ProductSourceRecord,
  ProductSpecs,
  ScrapedOffer,
  ScrapedProduct,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  IdentityContribution,
  ProductSourcePostProcessMergeService,
  ProductSourcePostProcessService,
  selectIdentitySpecRows,
} from '@fittkereso-backend/product';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  ProductMetricsService,
  SpecUnificationTrigger,
} from '@fittkereso-backend/metrics';
import { CustomLogger } from '@fittkereso-backend/logger';
import { filterDefinedSpecs } from '@fittkereso-backend/utils';
import { omit, pick, uniq } from 'lodash';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';

/**
 * Which fields each LLM call owns for one category. Read from the category
 * config every time — nothing in the calls names a spec.
 */
export interface CategorySpecScopes {
  /** primarySpecs ∪ matcherSpecs ∪ offerLevelSpecs: what the identity extraction fills. */
  identityKeys: string[];
  /** The listing-level specs (size, colour), which live on the offer rather than the product. */
  offerLevelKeys: string[];
  /** Every other schema field: what full spec unification fills. */
  unificationKeys: string[];
}

/**
 * The two LLM calls of an import, and every way of avoiding paying for them.
 *
 * - **Identity extraction** (extractIdentity): once per first-seen or changed
 *   listing. The updater calls it once the listing's own history is known
 *   (that decides whether a stored result can be reused) and before the
 *   identity decision, so the sanity check and name matching both see what
 *   it extracted.
 * - **Full spec unification** (unify): once per product per source — when a
 *   listing creates a product, or when a source first contributes to one.
 *
 * The importers call neither: they hand the updater deterministic data only.
 * That is what makes an importer's output free to produce, and puts the one
 * decision about whether to pay for a call next to the identity resolution
 * that knows whether this listing was seen before.
 */
@Injectable()
export class SpecPostProcessService {
  private readonly logger = new CustomLogger(SpecPostProcessService.name);

  constructor(
    private readonly categoryConfigService: CategoryConfigService,
    private readonly postProcess: ProductSourcePostProcessService,
    private readonly postProcessMerge: ProductSourcePostProcessMergeService,
    private readonly productMetrics: ProductMetricsService,
  ) {}

  public scopesOf(
    categorySlug: string,
    schema: SpecDefinitionJsonSchema,
  ): CategorySpecScopes {
    const config = this.categoryConfigService.getConfig(categorySlug);
    const schemaKeys = Object.keys(schema.properties);
    const offerLevelKeys = config?.offerLevelSpecs ?? [];
    const identityKeys = uniq([
      ...(config?.primarySpecs ?? []),
      ...(config?.matcherSpecs ?? []),
      ...offerLevelKeys,
    ]).filter((key) => schemaKeys.includes(key));

    return {
      identityKeys,
      offerLevelKeys,
      unificationKeys: schemaKeys.filter((key) => !identityKeys.includes(key)),
    };
  }

  /**
   * The listing's clean name and identity specs.
   *
   * `ownRecord` is this listing's record from an earlier import, when its own
   * history resolved it. If its input is unchanged — same deterministic
   * mapping, same title and spec rows — that record's extraction is reused and
   * nothing is called: the path every listing of a nightly re-import takes.
   * Otherwise the LLM extracts again, and the fields unification gave that
   * record are carried over, because unification does not re-run for a
   * listing its source has already contributed.
   *
   * Never throws for an LLM failure: the listing continues on its
   * deterministic data, with `nameCleaned: false`.
   */
  public async extractIdentity(params: {
    context: ProductImportContext;
    scrapedProduct: ScrapedProduct;
    ownRecord?: ProductSourceRecord;
  }): Promise<ScrapedProduct> {
    const { context, scrapedProduct, ownRecord } = params;
    const schema = this.categoryConfigService.getJsonSchema(
      scrapedProduct.category.slug,
    );
    if (!schema) return scrapedProduct;

    const scopes = this.scopesOf(scrapedProduct.category.slug, schema);
    const config = postProcessConfigOf(context.source.config);
    const specRows = context.source.config?.identityExtraction?.specRows;
    const deterministic = scrapedProduct.extractedSpecs ?? {};
    const rawTitle = scrapedProduct.originalName ?? scrapedProduct.model;
    const rows = selectIdentitySpecRows(scrapedProduct.rawSpecs, specRows);
    const description = config?.includeDescriptionInOfferIdentity
      ? scrapedProduct.description
      : undefined;
    const data = {
      brand: scrapedProduct.brand,
      model: rawTitle,
      specs: filterDefinedSpecs(pick(deterministic, scopes.identityKeys)),
    };
    const identityInputHash = hashOf({ ...data, rows, description });

    const stored = ownRecord?.scrapedProduct;
    if (
      stored &&
      !context.force &&
      ownRecord?.offerSpecsHash === scrapedProduct.offerSpecsHash &&
      ownRecord?.productSpecsHash === scrapedProduct.productSpecsHash &&
      stored.identityInputHash === identityInputHash
    ) {
      this.productMetrics.identityExtraction(context.source.name, 'reused');
      return this.reuse(scrapedProduct, stored, identityInputHash, scopes);
    }

    if (specRows?.length) {
      this.productMetrics.identitySpecRowsMatched(context.source.name, rows.length);
    }

    let identity: IdentityContribution | undefined;
    if (config?.enabled === false) {
      this.productMetrics.identityExtraction(context.source.name, 'disabled');
    } else {
      this.logger.debug('Running identity extraction', {
        ...logContextOf(context),
        specRows: rows.length,
      });
      identity = await this.postProcess.extractIdentity({
        data,
        rawSpecs: rows,
        description,
        schema,
        outputKeys: scopes.identityKeys,
        offerLevelSpecs: scopes.offerLevelKeys,
        ...llmOptionsOf(config),
      });
      this.productMetrics.identityExtraction(
        context.source.name,
        identity ? 'extracted' : 'failed',
      );
    }

    const merged = this.postProcessMerge.merge(
      { brand: scrapedProduct.brand, model: rawTitle, specs: deterministic },
      identity,
      undefined,
    );
    // Only this listing's own earlier record carries unification output worth
    // keeping; fresh deterministic values still win over it.
    const carried = pick(stored?.specs, scopes.unificationKeys);
    const offerLevel = pick(merged.specs, scopes.offerLevelKeys);

    return {
      ...scrapedProduct,
      brand: merged.brand,
      model: merged.model,
      displayName: `${merged.brand} ${merged.model}`.trim(),
      originalName: rawTitle,
      specs: { ...carried, ...omit(merged.specs, scopes.offerLevelKeys) },
      nameCleaned: merged.nameCleaned,
      identityInputHash,
      offers: withOfferLevelSpecs(scrapedProduct.offers, () => offerLevel),
    };
  }

  /**
   * Full spec unification for the source this listing came from: every
   * schema field outside the identity set, filled from the listing's whole
   * spec table, with its identity values as read-only context and the
   * golden sample (picked to these fields) as a style example.
   *
   * The result extends the listing's own specs — which the source record
   * stores, and which the product's spec merge folds in beside every other
   * source's. Never throws: without it the listing is saved with its
   * identity specs alone.
   */
  public async unify(params: {
    context: ProductImportContext;
    scrapedProduct: ScrapedProduct;
    trigger: SpecUnificationTrigger;
  }): Promise<ScrapedProduct> {
    const { context, scrapedProduct, trigger } = params;
    const schema = this.categoryConfigService.getJsonSchema(
      scrapedProduct.category.slug,
    );
    if (!schema) return scrapedProduct;

    const config = postProcessConfigOf(context.source.config);
    if (config?.enabled === false) {
      this.productMetrics.specUnification(context.source.name, trigger, 'disabled');
      return scrapedProduct;
    }

    const scopes = this.scopesOf(scrapedProduct.category.slug, schema);
    this.logger.debug('Running spec unification', {
      ...logContextOf(context),
      trigger,
    });

    const unified = await this.postProcess.processModelSpecs({
      data: {
        brand: scrapedProduct.brand,
        model: scrapedProduct.originalName ?? scrapedProduct.model,
        specs: filterDefinedSpecs(
          pick(scrapedProduct.extractedSpecs ?? {}, scopes.unificationKeys),
        ),
      },
      knownSpecs: filterDefinedSpecs(
        pick(
          { ...scrapedProduct.specs, ...scrapedProduct.offers?.[0]?.specs },
          scopes.identityKeys,
        ),
      ),
      rawSpecs: scrapedProduct.rawSpecs,
      description:
        config?.includeDescriptionInModelSpecs === false
          ? undefined
          : scrapedProduct.description,
      schema,
      outputKeys: scopes.unificationKeys,
      goldenSample: this.categoryConfigService.getGoldenSample(
        scrapedProduct.category.slug,
      ),
      ...llmOptionsOf(config),
    });

    this.productMetrics.specUnification(
      context.source.name,
      trigger,
      unified ? 'ok' : 'failed',
    );
    if (!unified?.specs) return scrapedProduct;

    return {
      ...scrapedProduct,
      specs: {
        ...scrapedProduct.specs,
        ...omit(unified.specs, scopes.identityKeys),
      },
    };
  }

  /**
   * The stored extraction, on today's listing: the name, specs and each
   * offer's listing-level specs come from the record, while price,
   * availability, images and identifiers stay as imported now.
   */
  private reuse(
    scrapedProduct: ScrapedProduct,
    stored: Partial<ScrapedProduct>,
    identityInputHash: string,
    scopes: CategorySpecScopes,
  ): ScrapedProduct {
    const storedOffers = stored.offers ?? [];
    const storedSpecsFor = (offer: ScrapedOffer, index: number) =>
      (offer.externalId &&
        storedOffers.find((candidate) => candidate.externalId === offer.externalId)
          ?.specs) ||
      storedOffers[index]?.specs ||
      storedOffers[0]?.specs;

    return {
      ...scrapedProduct,
      brand: stored.brand ?? scrapedProduct.brand,
      model: stored.model ?? scrapedProduct.model,
      displayName: stored.displayName ?? scrapedProduct.displayName,
      originalName: scrapedProduct.originalName ?? scrapedProduct.model,
      specs: stored.specs ?? scrapedProduct.specs,
      nameCleaned: stored.nameCleaned,
      identityInputHash,
      offers: withOfferLevelSpecs(scrapedProduct.offers, (offer, index) =>
        pick(storedSpecsFor(offer, index), scopes.offerLevelKeys),
      ),
    };
  }
}

/** The post-process block, wherever this source's config shape keeps it. */
function postProcessConfigOf(
  config: ProductSourceConfig | undefined,
): ProductSourcePostProcessConfig | undefined {
  if (isScrapingConfig(config)) return config.detailPage.postProcess;
  if (isArukeresoConfig(config)) return config.postProcess;
  return undefined;
}

function llmOptionsOf(config: ProductSourcePostProcessConfig | undefined) {
  return {
    model: config?.model,
    thinking: config?.thinking,
    effort: config?.effort,
    maxTokens: config?.maxTokens,
  };
}

/**
 * An offer's own specs (a page listing several variants, each with its own
 * size) win; every other offer gets the page's listing-level values.
 */
function withOfferLevelSpecs(
  offers: ScrapedOffer[] | undefined,
  pageSpecs: (offer: ScrapedOffer, index: number) => ProductSpecs,
): ScrapedOffer[] | undefined {
  return offers?.map((offer, index) => ({
    ...offer,
    specs: offer.specs ?? pageSpecs(offer, index),
  }));
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** `taskId` is present on the scrape path only, and absent on a feed run. */
function logContextOf(context: ProductImportContext): Record<string, unknown> {
  return { taskId: context.task?.id, url: context.url, source: context.source.name };
}
