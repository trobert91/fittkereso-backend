import { Injectable } from '@nestjs/common';
import {
  isFeedSourceType,
  ListingIdentityKey,
  ProductModel,
  ProductSourceRecord,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { DynamicConfigService, ReidentifyMode } from '@fittkereso-backend/dynamic-config';
import {
  applyGates,
  FailedGate,
  ListingExclusion,
  primarySpecMismatches,
  ProductKeyLookupService,
} from '@fittkereso-backend/product-identity';
import { OfferComposerService, ProductMergeService } from '@fittkereso-backend/product';
import { ProductMetricsService } from '@fittkereso-backend/metrics';
import { CustomLogger } from '@fittkereso-backend/logger';
import { storedOfferExternalId } from '@fittkereso-backend/utils';
import { compact, isEmpty, pick, uniq } from 'lodash';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';
import {
  IdentityKeyChange,
  identityKeyChangeOf,
  identityKeyOf,
  isNamed,
  KeyIdentifiers,
  storedIdentityKeyOf,
} from './listing-identity-key';

/** The identity parts of ListingInputHashes. */
const IDENTITY_PARTS = ['feedIdentity', 'pageIdentity'] as const;

/**
 * What re-identification makes of one import of a listing, before any
 * product is chosen:
 * - `none`: not in question — no history, a pinned or unnamed listing, a
 *   forced resync, a new model rule, the mode off, or an unchanged key;
 * - `fits`: its key changed, but what changed agrees with its product;
 * - `blocked`: it no longer fits, but another listing of its seller on the
 *   product carries the same offer, so it cannot leave alone;
 * - `contradicts`: it no longer fits, and is to be identified again.
 *
 * `key` is what its record stores: the key now when the product is decided
 * for it, the one decided before when it is not (a failed extraction, a
 * blocked or shadowed move) — so the change is seen again. Undefined: no key
 * is kept, and the next import reads it off the record.
 */
export type ReidentifyCheck =
  | { kind: 'none' | 'fits'; key?: ListingIdentityKey }
  | { kind: 'blocked'; key: ListingIdentityKey }
  | {
      kind: 'contradicts';
      /** The key now, and the one its product was decided under. */
      key: ListingIdentityKey;
      before: ListingIdentityKey;
      change: IdentityKeyChange;
      /** The product it sits on, its record there, and what of it must not vouch for itself. */
      from: ProductModel;
      record: ProductSourceRecord;
      exclusion: ListingExclusion;
      /** No other identifying listing sits on its product. */
      alone: boolean;
    };

/**
 * Whether a listing that sits on a product is still that product, when what
 * it is identified by changed: its brand, model, identifiers or its
 * category's primary and matcher specs (ListingIdentityKey) — a page read
 * for the first time, say, or a shop correcting its feed.
 *
 * The fit check comes first, and costs no call: enrichment — a spec its
 * product lacked, or one that agrees — keeps the listing where it is. Only a
 * contradiction is identified again (ProductScrapeUpdaterService), and only
 * when the mode (dynamic config import.reidentifyOnIdentityChange) is not
 * off. Feed sources only, for now: a scraping source's variant pages share
 * their offers too freely to move one alone.
 */
@Injectable()
export class ListingReidentificationService {
  private readonly logger = new CustomLogger(ListingReidentificationService.name);

  constructor(
    private readonly dynamicConfig: DynamicConfigService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly mergeService: ProductMergeService,
    private readonly offerComposer: OfferComposerService,
    private readonly keyLookup: ProductKeyLookupService,
    private readonly productMetrics: ProductMetricsService,
  ) {}

  get mode(): ReidentifyMode {
    return this.dynamicConfig.import?.reidentifyOnIdentityChange ?? 'off';
  }

  public async check(params: {
    context: ProductImportContext;
    /** What the identity extraction produced. */
    extracted: ScrapedProduct;
    normalizedModel: string | null;
    identifiers: KeyIdentifiers[];
    /** The listing's offers' externalIds now, as stored. */
    externalIds: (string | undefined)[];
    brandId: string | undefined;
    /** The product its own history found, unless that was a pinned task. */
    product: ProductModel | undefined;
    /** Its own record on that product. */
    ownRecord: ProductSourceRecord | undefined;
  }): Promise<ReidentifyCheck> {
    const { context, extracted, product, ownRecord } = params;
    const mode = this.mode;
    if (mode === 'off' || !isFeedSourceType(context.source.type) || ownRecord?.identityPinned) {
      return { kind: 'none' };
    }

    const keySpecs = this.keySpecsOf(extracted.category.slug);
    const key = identityKeyOf({
      brand: extracted.brand,
      normalizedModel: params.normalizedModel,
      identifiers: params.identifiers,
      siblingIds: (extracted.siblingExternalIds ?? []).filter((id) => id !== extracted.externalId),
      specs: extracted.specs,
      keySpecs,
    });
    // A listing new here is decided now, under this key.
    if (!product || !ownRecord) return { kind: 'none', key };

    const before = storedIdentityKeyOf(ownRecord, keySpecs);
    // A failed extraction tells nothing new: the key decided before stays.
    if (!isNamed(extracted)) return { kind: 'none', key: before };
    if (!before || this.isRefresh(context, extracted, ownRecord)) return { kind: 'none', key };

    const change = identityKeyChangeOf(before, key);
    if (!change) return { kind: 'none', key };

    const ownOffers = {
      sellerId: context.source.seller.id,
      externalIds: uniq([...this.storedKeysOf(ownRecord), ...compact(params.externalIds)]),
    };
    const productSpecs = await this.mergeService.specsWithout(product, [ownRecord.id]);
    const exclusion: ListingExclusion = {
      recordId: ownRecord.id,
      productId: product.id,
      productSpecs,
      ownOffers,
    };

    const misfit = await this.misfitOf({ ...params, product, change, exclusion });
    if (!misfit) {
      this.productMetrics.scrapeResolutionOutcome(context.source.name, 'reidentify_fits');
      this.logger.debug('A listing\'s identity key changed, and it still fits its product', {
        ...this.logContextOf(context, product),
        change,
      });
      return { kind: 'fits', key };
    }

    if (this.isBlocked(context, product, ownRecord)) {
      this.productMetrics.scrapeResolutionOutcome(context.source.name, 'reidentify_blocked');
      this.logger.warn(
        'A listing no longer fits its product, but another listing of its seller there carries the same offer — it stays',
        { ...this.logContextOf(context, product), change, misfit },
      );
      return { kind: 'blocked', key: before };
    }

    this.logger.log('A listing no longer fits its product: identifying it again', {
      ...this.logContextOf(context, product),
      mode,
      change,
      misfit,
    });
    return {
      kind: 'contradicts',
      key,
      before,
      change,
      from: product,
      record: ownRecord,
      exclusion,
      alone: !(product.sources ?? []).some(
        (record) =>
          record.id !== ownRecord.id &&
          !!record.source &&
          record.source.identifiesProducts !== false,
      ),
    };
  }

  /**
   * How a listing's identity key differs from the one its record keeps — a
   * preview's question (simulate_product_source_import): no fit check, no
   * decision, whatever the mode. Undefined when nothing changed; `null` when
   * the record has no key to compare (its listing was never named).
   */
  public keyChangeOf(params: {
    extracted: ScrapedProduct;
    normalizedModel: string | null;
    identifiers: KeyIdentifiers[];
    record: ProductSourceRecord;
  }): IdentityKeyChange | null | undefined {
    const { extracted, record } = params;
    const keySpecs = this.keySpecsOf(extracted.category.slug);
    const before = storedIdentityKeyOf(record, keySpecs);
    if (!before) return null;
    return identityKeyChangeOf(
      before,
      identityKeyOf({
        brand: extracted.brand,
        normalizedModel: params.normalizedModel,
        identifiers: params.identifiers,
        siblingIds: (extracted.siblingExternalIds ?? []).filter((id) => id !== extracted.externalId),
        specs: extracted.specs,
        keySpecs,
      }),
    );
  }

  /**
   * Why the listing no longer fits its product, or undefined when it does:
   * - its brand or model changed, or an identifier it had is gone: what it
   *   was found by no longer holds;
   * - an identifier it gained points at another product;
   * - a key spec it changed contradicts what the product's other listings
   *   say, by the gates the matcher applies: the identifier tier's when one
   *   of its identifiers finds the product through another listing's offer
   *   (primary specs, less the ones shops get wrong), the name tier's
   *   otherwise (primary and matcher specs). A spec only one side states
   *   fits: that is what enrichment is.
   */
  private async misfitOf(params: {
    context: ProductImportContext;
    extracted: ScrapedProduct;
    identifiers: KeyIdentifiers[];
    brandId: string | undefined;
    product: ProductModel;
    change: IdentityKeyChange;
    exclusion: ListingExclusion;
  }): Promise<{ reason: string; gates?: FailedGate[]; productIds?: string[] } | undefined> {
    const { context, extracted, product, change, exclusion } = params;
    if (change.anchorsChanged) return { reason: 'anchors_changed' };

    const keyMatches = await this.keyLookup.lookup({
      sourceId: context.source.id,
      siblingIds: (extracted.siblingExternalIds ?? []).filter((id) => id !== extracted.externalId),
      gtins: compact(params.identifiers.map((identifier) => identifier.gtin)),
      mpns: compact(params.identifiers.map((identifier) => identifier.mpn)),
      brandId: params.brandId,
      categoryId: extracted.category.id,
      ownOffers: exclusion.ownOffers,
    });
    const elsewhere = uniq(
      keyMatches
        .filter((match) => change.addedIdentifiers.includes(match.key))
        .map((match) => match.productId)
        .filter((productId) => productId !== product.id),
    );
    if (!isEmpty(elsewhere)) return { reason: 'identifier_elsewhere', productIds: elsewhere };
    if (isEmpty(change.changedSpecs)) return undefined;

    const categoryConfig = this.categoryConfigService.getConfig(extracted.category.slug);
    const querySpecs = pick(extracted.specs ?? {}, change.changedSpecs) as ProductSpecs;
    const candidateSpecs = exclusion.productSpecs;
    const foundByIdentifier = keyMatches.some(
      (match) => match.via !== 'sibling' && match.productId === product.id,
    );
    const ignored = new Set(categoryConfig?.matchingConfig?.identifierGateExcludes ?? []);
    const gates = foundByIdentifier
      ? primarySpecMismatches({ querySpecs, candidateSpecs, categoryConfig }).filter(
          (gate) => !gate.spec || !ignored.has(gate.spec),
        )
      : applyGates({
          queryModel: '',
          candidateModel: '',
          querySpecs,
          candidateSpecs,
          categoryConfig,
        }).filter(
          (gate) => gate.gate === 'primarySpecMismatch' || gate.gate === 'matcherSpecMismatch',
        );
    return isEmpty(gates) ? undefined : { reason: 'spec_mismatch', gates };
  }

  /**
   * Another current identifying listing of the same seller on the product
   * carries one of this listing's offers: the offer cannot follow this one
   * alone, and nothing moves.
   */
  private isBlocked(
    context: ProductImportContext,
    product: ProductModel,
    record: ProductSourceRecord,
  ): boolean {
    const sellerId = context.source.seller.id;
    return this.storedKeysOf(record).some((externalId) =>
      this.offerComposer
        .currentCarriers({ model: product, sellerId, externalId })
        .some((carrier) => carrier.id !== record.id && carrier.source?.identifiesProducts !== false),
    );
  }

  /**
   * An import that only re-asked what was asked before: a forced resync of
   * an unchanged input, or a model asked again under a new rule. Neither is
   * news about the listing, and a new rule renames every listing at once.
   */
  private isRefresh(
    context: ProductImportContext,
    extracted: ScrapedProduct,
    record: ProductSourceRecord,
  ): boolean {
    const storedContract = record.scrapedProduct?.modelContract;
    if (storedContract && extracted.modelContract && storedContract !== extracted.modelContract) {
      return true;
    }
    if (!context.force) return false;
    const fresh = extracted.inputHashes ?? {};
    const stored = record.inputHashes ?? {};
    return IDENTITY_PARTS.every((part) => !fresh[part] || fresh[part] === stored[part]);
  }

  /** The category's primarySpecs and matcherSpecs. */
  private keySpecsOf(categorySlug: string): string[] {
    const config = this.categoryConfigService.getConfig(categorySlug);
    return uniq([...(config?.primarySpecs ?? []), ...(config?.matcherSpecs ?? [])]);
  }

  /** The externalIds a record's offers are stored under. */
  private storedKeysOf(record: ProductSourceRecord): string[] {
    return uniq(
      compact(
        (record.scrapedProduct?.offers ?? []).map((entry) => storedOfferExternalId(record, entry)),
      ),
    );
  }

  private logContextOf(context: ProductImportContext, product: ProductModel) {
    return {
      taskId: context.task?.id,
      url: context.url,
      source: context.source.name,
      productId: product.id,
    };
  }
}
