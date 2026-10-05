import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  CategorySpecPromptExamples,
  isArukeresoConfig,
  isScrapingConfig,
  modelExcludedSpecKeys,
  ProductSource,
  ProductSourceConfig,
  ProductSourcePostProcessConfig,
  ProductSourceRecord,
  ProductSpecs,
  ScrapedOffer,
  ScrapedProduct,
  ScrapedProductFlag,
  SpecDefinitionJsonSchema,
  categorySectionOf,
} from '@fittkereso-backend/database';
import {
  findDescriptionEvidence,
  getYearSpecKeys,
  IdentityContribution,
  MODEL_PROMPT_VERSION,
  ModelRuleRequest,
  normalizeYearSpecs,
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
import { filterDefinedSpecs, htmlToText } from '@fittkereso-backend/utils';
import { difference, isEmpty, isNil, omit, omitBy, pick, uniq } from 'lodash';
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
  /** What the identity extraction is told about the model name. */
  modelRule: ModelRuleRequest;
  /** The category's examples for both prompts' rules (promptConfig.specExamples). */
  promptExamples?: CategorySpecPromptExamples;
  /** The words a description's excerpts are cut around (evidenceKeywords). */
  evidenceKeywords: string[];
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

    const examples = config?.matchingConfig?.model?.examples;

    return {
      identityKeys,
      offerLevelKeys,
      unificationKeys: schemaKeys.filter((key) => !identityKeys.includes(key)),
      modelRule: {
        excludedKeys: modelExcludedSpecKeys(config).filter((key) =>
          schemaKeys.includes(key),
        ),
        ...(examples?.length ? { examples } : {}),
      },
      promptExamples: config?.promptConfig?.specExamples,
      evidenceKeywords: config?.evidenceKeywords ?? [],
    };
  }

  /** Whether this source runs the identity extraction (`postProcess.identity`, on by default). */
  public identityEnabledFor(source: ProductSource): boolean {
    return postProcessConfigOf(source.config)?.identity !== false;
  }

  /**
   * The contract a model of this category is asked under now
   * (ScrapedProduct.modelContract): a stored one under another is asked
   * again. Undefined for a category without a schema.
   */
  public modelContractOf(categorySlug: string): string | undefined {
    const schema = this.categoryConfigService.getJsonSchema(categorySlug);
    return schema ? contractOf(this.scopesOf(categorySlug, schema)) : undefined;
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
   * deterministic data with no `model`, flagged `identity_failed`, and the
   * next import asks again. With the source's `identity` off it is flagged
   * `identity_off` and nothing is called.
   *
   * Its result is what identity matching compares, so every year in it is
   * normalised (withNormalizedYears) whichever piece it came from.
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
    const specRows = categorySectionOf(
      context.source.config,
      scrapedProduct.category.slug,
    )?.identitySpecRows;
    const deterministic = scrapedProduct.extractedSpecs ?? {};
    const rawTitle = scrapedProduct.originalName;
    const rows = selectIdentitySpecRows(scrapedProduct.rawSpecs, specRows);
    const { description, descriptionEvidence } = identityDescriptionOf(
      scrapedProduct.description,
      config,
      scopes,
    );
    const data = {
      brand: scrapedProduct.brand,
      model: rawTitle,
      specs: filterDefinedSpecs(pick(deterministic, scopes.identityKeys)),
    };
    // A listing whose description has no keyword hashes as it did before its
    // source sent excerpts, so it isn't asked again for nothing.
    const identityInputHash = hashOf({ ...data, rows, description, descriptionEvidence });

    const enabled = config?.identity !== false;
    const modelContract = contractOf(scopes);
    const callIdentity = () =>
      this.postProcess.extractIdentity({
        data,
        rawSpecs: rows,
        description,
        descriptionEvidence,
        schema,
        outputKeys: scopes.identityKeys,
        offerLevelSpecs: scopes.offerLevelKeys,
        modelRule: scopes.modelRule,
        promptExamples: scopes.promptExamples,
        ...llmOptionsOf(config),
      });

    // Only a result that named the listing is worth keeping: one that did
    // not (the call failed, or was off) is asked again.
    const stored = ownRecord?.scrapedProduct;
    if (
      stored?.model &&
      !context.force &&
      ownRecord?.offerSpecsHash === scrapedProduct.offerSpecsHash &&
      ownRecord?.productSpecsHash === scrapedProduct.productSpecsHash &&
      stored.identityInputHash === identityInputHash
    ) {
      const reused = this.reuse(scrapedProduct, stored, identityInputHash, scopes);
      // A model asked under an older rule is asked again, where the name is
      // used: a contributing source's listing names and matches nothing.
      const stale =
        enabled &&
        stored.modelContract !== modelContract &&
        context.source.identifiesProducts !== false;
      if (!stale) {
        this.productMetrics.identityExtraction(context.source.name, 'reused');
        return withNormalizedYears(reused, schema);
      }
      return withNormalizedYears(
        await this.refreshModel(reused, callIdentity, modelContract, context, scopes),
        schema,
      );
    }

    if (specRows?.length) {
      this.productMetrics.identitySpecRowsMatched(context.source.name, rows.length);
    }

    let identity: IdentityContribution | undefined;
    if (!enabled) {
      this.productMetrics.identityExtraction(context.source.name, 'disabled');
    } else {
      this.logger.debug('Running identity extraction', {
        ...logContextOf(context),
        specRows: rows.length,
      });
      identity = await callIdentity();
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

    return withNormalizedYears(
      {
        ...scrapedProduct,
        brand: merged.brand,
        // Only a name the call returned: without one the listing keeps its
        // title alone, and its flags say why.
        model: merged.model,
        modelContract: merged.model ? modelContract : undefined,
        specs: { ...carried, ...omit(merged.specs, scopes.offerLevelKeys) },
        flags: withIdentityFlag(
          scrapedProduct.flags,
          merged.model ? undefined : enabled ? 'identity_failed' : 'identity_off',
        ),
        identityInputHash,
        offers: withOfferLevelSpecs(scrapedProduct.offers, () => offerLevel),
      },
      schema,
    );
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
    if (config?.specs === false) {
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
        model: scrapedProduct.originalName,
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
      promptExamples: scopes.promptExamples,
      ...llmOptionsOf(config),
    });

    this.productMetrics.specUnification(
      context.source.name,
      trigger,
      unified ? 'ok' : 'failed',
    );
    if (!unified?.specs) return scrapedProduct;

    return withNormalizedYears(
      {
        ...scrapedProduct,
        specs: {
          ...scrapedProduct.specs,
          ...omit(unified.specs, scopes.identityKeys),
        },
      },
      schema,
    );
  }

  /**
   * The stored extraction, on today's listing: the name, specs and each
   * offer's listing-level specs come from the record, while price,
   * availability, images and identifiers stay as imported now.
   */
  /**
   * A reused extraction whose model was asked under another contract (other
   * left-out specs, examples or prompt version): asks the LLM again and takes
   * the model from it, so the listing is renamed under the current rule while
   * its specs stay as stored. A call that names nothing keeps the stored
   * model under its old contract, to be asked on its next import.
   *
   * The specs a new rule leaves out of the model are taken too, where the
   * stored listing has none: a word the old model kept (a frame word, say)
   * is then compared as its spec value instead of lost. A stored value wins.
   */
  private async refreshModel(
    reused: ScrapedProduct,
    callIdentity: () => Promise<IdentityContribution | undefined>,
    contract: string,
    context: ProductImportContext,
    scopes: CategorySpecScopes,
  ): Promise<ScrapedProduct> {
    this.logger.debug('Refreshing the model of a reused extraction', logContextOf(context));
    const identity = await callIdentity();
    if (!identity?.model) {
      this.productMetrics.identityExtraction(context.source.name, 'refresh_failed');
      return reused;
    }

    this.productMetrics.identityExtraction(context.source.name, 'refreshed');
    const leftOut = difference(scopes.modelRule.excludedKeys, scopes.offerLevelKeys);
    const gained = omitBy(
      pick(identity.specs ?? {}, leftOut),
      (value, key) => isNil(value) || !isNil(reused.specs?.[key]),
    );
    return {
      ...reused,
      model: identity.model,
      modelContract: contract,
      specs: isEmpty(gained) ? reused.specs : { ...reused.specs, ...gained },
    };
  }

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
      model: stored.model,
      modelContract: stored.modelContract,
      specs: stored.specs ?? scrapedProduct.specs,
      flags: withIdentityFlag(scrapedProduct.flags, undefined),
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

/**
 * What of the listing's description the identity extraction gets, by the
 * source's `identityDescription` mode: nothing (the default), the excerpts
 * around the category's evidence keywords, or the whole of it. A description
 * with no keyword gives no excerpts, so its listing is asked as before.
 */
function identityDescriptionOf(
  description: string | undefined,
  config: ProductSourcePostProcessConfig | undefined,
  scopes: CategorySpecScopes,
): { description?: string; descriptionEvidence?: string[] } {
  const setting = config?.identityDescription;
  if (!description?.trim() || !setting || setting.mode === 'none') return {};
  if (setting.mode === 'full') return { description };

  const excerpts = findDescriptionEvidence(htmlToText(description), scopes.evidenceKeywords, setting);
  return isEmpty(excerpts) ? {} : { descriptionEvidence: excerpts };
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
 * The listing with every year field in the one form `normalizeYear` gives it,
 * on the page's specs and on each offer's. The spec normaliser sees each piece
 * alone; what is merged here also holds pieces it never sees — an importer's
 * `releaseYear`, values carried over from a stored record, an offer's own page
 * specs — and this object is what identity matching compares and the source
 * record stores.
 */
function withNormalizedYears(
  product: ScrapedProduct,
  schema: SpecDefinitionJsonSchema,
): ScrapedProduct {
  if (isEmpty(getYearSpecKeys(schema))) return product;

  return {
    ...product,
    specs: product.specs && normalizeYearSpecs(product.specs, schema),
    offers: product.offers?.map((offer) =>
      offer.specs
        ? { ...offer, specs: normalizeYearSpecs(offer.specs, schema) }
        : offer,
    ),
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

const IDENTITY_FLAGS: readonly ScrapedProductFlag[] = ['identity_off', 'identity_failed'];

/** The listing's flags with the identity extraction's own replaced by `flag`. */
function withIdentityFlag(
  flags: ScrapedProductFlag[] | undefined,
  flag: ScrapedProductFlag | undefined,
): ScrapedProductFlag[] | undefined {
  const next = [...(flags ?? []).filter((each) => !IDENTITY_FLAGS.includes(each)), ...(flag ? [flag] : [])];
  return isEmpty(next) ? undefined : next;
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** What a model is asked under: its left-out specs, examples and prompt version. */
function contractOf(scopes: CategorySpecScopes): string {
  return hashOf({ ...scopes.modelRule, version: MODEL_PROMPT_VERSION });
}

/** `taskId` is present on the scrape path only, and absent on a feed run. */
function logContextOf(context: ProductImportContext): Record<string, unknown> {
  return { taskId: context.task?.id, url: context.url, source: context.source.name };
}
