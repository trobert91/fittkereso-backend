import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
  brandLock,
  offerKeyLock,
  productLock,
  Offer,
  OfferRepository,
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductSource,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  OfferIdentityConflictError,
  ProductImportTaskRepository,
  Seller,
} from '@fittkereso-backend/database';
import type { ListingMatchDecision } from '@fittkereso-backend/database';
import {
  FailedGate,
  IdentifierTier,
  KeyMatch,
  ListingMatchService,
  ProductDuplicateService,
  ProductKeyLookupService,
} from '@fittkereso-backend/product-identity';
import {
  filterDefinedSpecs,
  generateSlug,
  nameOf,
  normalize,
  inspectGtin,
  normalizeMpn,
  normalizeUrl,
  offerExternalIdOf,
  storedOfferExternalId,
} from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BRAND_NOT_IDENTIFIED,
  BrandResolutionService,
  ContributorDetachService,
  OfferComposerService,
  OfferMatchingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductModelFactoryService,
  ProductNormalizerService,
  ProductSourceRecordUpdaterService,
} from '@fittkereso-backend/product';
import { ScrapedOffer, ScrapedProduct } from '@fittkereso-backend/product';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';
import { compact, difference, isEmpty, minBy, pick, uniq } from 'lodash';
import { SpecPostProcessService } from './spec-post-process.service';
import {
  IdentityRecheckVia,
  IdentityResolvedVia,
  ProductMetricsService,
} from '@fittkereso-backend/metrics';

interface ResolvedIdentity {
  model?: ProductModel;
  isExistingMatch: boolean;
  /**
   * What listing matching decided. Set by Path 4 and only by Path 4, so its
   * presence is also how the post-save step knows to look for duplicates —
   * everything before it resolved by a stored id or a shared identifier, and
   * has nothing new to compare by name.
   */
  decision?: ListingMatchDecision;
  /**
   * Every product one of this listing's identifiers (declared sibling, GTIN,
   * MPN) points at, whether or not the listing attached to it. Once the
   * listing's product is saved, each one that is a different product becomes
   * a duplicate pair.
   */
  keyMatches: KeyMatch[];
  /** Primary-spec contradictions between the listing and each key-matched product. */
  keyGates: Record<string, FailedGate[]>;
}

/** An offer's identifiers in stored form, index-aligned with ScrapedProduct.offers. */
interface OfferIdentifiers {
  gtin?: string;
  mpn?: string;
}

/** A listing found through its own history: a pin, its offer, or its record. */
interface HistoryHit {
  model: ProductModel;
  via: Extract<
    IdentityResolvedVia,
    'pinned' | 'offer_external_id' | 'external_id' | 'source_url'
  >;
}

/** Everything the locked write of one listing needs. */
interface ListingWrite {
  context: ProductImportContext;
  /** What the identity extraction produced: the input of every identity decision. */
  extracted: ScrapedProduct;
  /**
   * The listing as stored: the extraction, unified when this source is new to
   * the product, with each offer carrying the externalId it is stored under.
   */
  listing: ScrapedProduct;
  normalizedSourceName: string;
  identifiers: OfferIdentifiers[];
  /** Each offer's Offer.externalId, index-aligned; undefined where ids collided. */
  externalIds: (string | undefined)[];
}

/** The product a listing was written to, and the identity it was written under. */
interface WrittenListing {
  model: ProductModel;
  identity: ResolvedIdentity;
  created: boolean;
}

/** The identity decision repeated under the brand's lock. */
interface Recheck {
  keyMatches: KeyMatch[];
  keyGates: Record<string, FailedGate[]>;
  /** The product a concurrent import created meanwhile, when one was found. */
  found?: {
    productId: string;
    via: IdentityRecheckVia;
    decision?: ListingMatchDecision;
  };
}

@Injectable()
export class ProductScrapeUpdaterService {
  private readonly logger = new CustomLogger(ProductScrapeUpdaterService.name);

  constructor(
    private readonly listingMatch: ListingMatchService,
    private readonly duplicateService: ProductDuplicateService,
    private readonly modelFactory: ProductModelFactoryService,
    private readonly productRepo: ProductModelRepository,
    private readonly taskRepo: ProductImportTaskRepository,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly sourceRecordUpdater: ProductSourceRecordUpdaterService,
    private readonly mergeService: ProductMergeService,
    private readonly imageCopyService: ProductImageCopyService,
    private readonly productMetricsService: ProductMetricsService,
    private readonly productNormalizer: ProductNormalizerService,
    private readonly offerMatching: OfferMatchingService,
    private readonly offerRepo: OfferRepository,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly keyLookup: ProductKeyLookupService,
    private readonly brandResolution: BrandResolutionService,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly locks: AdvisoryLockService,
    private readonly offerComposer: OfferComposerService,
    private readonly contributorDetach: ContributorDetachService,
  ) {}

  public async createOrUpdateProduct(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
  ): Promise<ProductModel | undefined> {
    if (!scrapedProduct.category?.id) {
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        'skipped_no_category',
      );
      this.logger.warn('Skipping scrape — no category identified', {
        taskId: context.task?.id,
        url: context.url,
        displayName: scrapedProduct.displayName,
      });
      return undefined;
    }

    // A source that does not identify products never decides which product a
    // listing is: it joins its seller's offer, or waits for one.
    if (context.source.identifiesProducts === false) {
      return this.contributeListing(context, scrapedProduct);
    }

    try {
      // Every offer belongs to its ProductSource's own seller — no per-offer
      // seller resolution needed. Path 2 keys its (seller, externalId)
      // lookup off this.
      const seller = context.source.seller;
      // Normalized once, here: identity resolution looks them up and the offer
      // upsert stores them, and each GTIN's outcome must be counted once.
      const identifiers = this.normalizeOfferIdentifiers(
        context,
        scrapedProduct.offers ?? [],
      );
      // Resolved for the whole page at once, because uniqueness is a property
      // of the SET, not of any one offer — see resolveOfferExternalIds.
      const externalIds = this.resolveOfferExternalIds(
        context,
        scrapedProduct.offers ?? [],
      );

      // The listing's own history first, because it decides whether the
      // extraction can reuse this listing's stored result instead of calling
      // the LLM — the path every unchanged listing of a re-import takes.
      const history = await this.resolveFromHistory(
        context,
        scrapedProduct,
        seller,
      );
      const extracted = await this.specPostProcess.extractIdentity({
        context,
        scrapedProduct,
        ownRecord: this.ownRecordOf(context, scrapedProduct, history?.model),
      });

      // The decision reads what the extraction produced: the sanity check
      // compares its specs, and name matching its cleaned name.
      const { identity, brandResolved } = await this.resolveProductIdentity(
        context,
        extracted,
        identifiers,
        history,
      );
      const listing = await this.unifyForNewSource(
        context,
        extracted,
        identity,
        brandResolved,
      );

      // Everything above only reads (and calls the LLM). Everything below
      // writes, under the lock of the product it writes to.
      const write: ListingWrite = {
        context,
        extracted,
        listing: this.withStoredOffers(listing, externalIds),
        normalizedSourceName: this.buildNormalizedSourceName(listing),
        identifiers,
        externalIds,
      };
      const written = identity.model
        ? await this.attachToProduct(write, identity, identity.model.id)
        : await this.createProduct(write, identity);

      // Outside the locks: both only add pair rows, with ON CONFLICT.
      if (written.identity.decision) {
        await this.detectDuplicates(context, written.model);
      }
      // After name-based detection, so where both found the same pair the
      // identifier — the stronger evidence — is what the pair shows.
      await this.recordKeyPairs(context, written.model, written.identity);
      return written.model;
    } catch (error) {
      // do not fail the whole scraping if brand resolution fails
      if ((error as Error).message?.includes('Brand could not be identified')) {
        this.productMetricsService.productBrandResolutionFailed(
          context.source.name,
        );
        return undefined;
      }
      throw error;
    }
  }

  // One canonical name for this scrape, stored on the new ProductSourceRecord
  // row and used as a new product's first normalizedName (mergeSources then
  // rebuilds it from the resolved brand).
  private buildNormalizedSourceName(scrapedProduct: ScrapedProduct): string {
    const strategy =
      this.categoryConfigService.getConfig(scrapedProduct.category?.slug)
        ?.normalizationStrategy ?? 'full-sorted';
    return this.productNormalizer.normalizeProduct({
      brand: scrapedProduct.brand,
      model: scrapedProduct.model,
      displayName: scrapedProduct.displayName,
      strategy,
    });
  }

  /**
   * A listing of a source that does not identify products — a shop's Google
   * feed beside its Árukereső feed, say. No identity work at all: no history
   * paths, identifiers, extraction or name matching. It joins the offer its
   * seller already has under one of its externalIds, on that offer's
   * product; with none, it is stored unattached, and the identifying listing
   * that writes the offer attaches it (attachWaitingRecords).
   *
   * It never creates a product or an offer, and never touches a product's
   * names, category, image or aliases: it contributes offer fields and specs,
   * by its source's priority.
   */
  private async contributeListing(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
  ): Promise<ProductModel | undefined> {
    const seller = context.source.seller;
    const externalIds = this.resolveOfferExternalIds(context, scrapedProduct.offers ?? []);
    const keys = uniq(compact(externalIds));
    if (isEmpty(keys)) {
      this.logger.warn(
        'A listing of a source that does not identify products carries no offer externalId, so it can never join an offer',
        { taskId: context.task?.id, url: context.url, source: context.source.name },
      );
    }
    const write: ListingWrite = {
      context,
      extracted: scrapedProduct,
      listing: this.withStoredOffers(scrapedProduct, externalIds),
      normalizedSourceName: this.buildNormalizedSourceName(scrapedProduct),
      identifiers: [],
      externalIds,
    };

    // Twice at most: the offer can appear, move or go between the lookup and
    // the lock, and the second pass then takes the other branch.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const offer = await this.offerRepo.findFirstBySellerAndExternalIdsWithModelRelations(
        seller.id,
        keys,
        this.getProductRelations(),
      );
      await this.detachOwnRecordElsewhere(context, offer?.model?.id);

      if (!offer?.model) {
        if (await this.storeUnattached(write, keys)) return undefined;
        continue;
      }

      // Only when its own post-process config enables it, and only the first
      // time this source contributes to the product.
      const listing = await this.unifyForNewSource(
        context,
        scrapedProduct,
        { model: offer.model, isExistingMatch: true, keyMatches: [], keyGates: {} },
        true,
      );
      const model = await this.writeContribution(
        { ...write, listing: this.withStoredOffers(listing, externalIds) },
        offer.model.id,
        keys,
      );
      if (model) return model;
    }
    throw new Error(
      `The offer of ${context.url} kept changing while its listing was written; the task retries it`,
    );
  }

  /**
   * A contributing listing onto the product its offer is on, under the
   * product's lock: its record (brought over while it waited unattached), the
   * product's specs merged again, and the seller's offers composed with its
   * values. Undefined when the offer is no longer on that product: the caller
   * looks again.
   */
  private async writeContribution(
    write: ListingWrite,
    productId: string,
    keys: string[],
  ): Promise<ProductModel | undefined> {
    const { context, listing, normalizedSourceName } = write;
    const seller = context.source.seller;

    return this.locks.withLocks([productLock(productId)], async () => {
      const offers = await this.offerRepo.findBySellerAndExternalIds(seller.id, keys);
      if (!offers.some((offer) => offer.model?.id === productId)) return undefined;

      const model = await this.productRepo.findOneOrFail({
        where: { id: productId },
        relations: this.getProductRelations(),
      });
      await this.adoptOwnRecord(context, model);
      const previousExternalIds = this.storedExternalIdsOf(context, model);

      await this.sourceRecordUpdater.upsertSourceRecord({
        model,
        scrapedProduct: listing,
        externalId: listing.externalId,
        source: context.source,
        sourceUrl: context.url,
        normalizedSourceName,
        feedRowHash: context.feedRowHash,
      });
      await this.mergeService.mergeSources(model);
      // Before the offers: an offer's sourceRecord must be saved first.
      await this.productRepo.save(model);
      this.productMetricsService.scrapeResolutionOutcome(context.source.name, 'contributed');
      this.productMetricsService.productUpdated(context.source.name);
      await this.writeBackToTask(context, model);

      const composed = await this.offerComposer.compose({
        model,
        seller,
        externalIds: keys,
        sighted: true,
        create: false,
      });
      this.reportConflicts(context, composed.conflicts);
      await this.dealWithDroppedOffers({
        context,
        model,
        dropped: difference(previousExternalIds, keys),
      });
      await this.mergeService.recomputePrice(model);
      await this.productRepo.save(model);
      return model;
    });
  }

  /**
   * Stores a contributing listing with no product, under its offer keys. An
   * identifying listing holds the same keys from attaching the waiting records
   * until its offers are written, so of the two, whichever comes second sees
   * the other. False when the offer turned up meanwhile, or the record was
   * attached: the caller joins it instead.
   */
  private async storeUnattached(write: ListingWrite, keys: string[]): Promise<boolean> {
    const { context, listing } = write;
    const seller = context.source.seller;

    return this.locks.withLocks(
      keys.map((key) => offerKeyLock(seller.id, key)),
      async () => {
        const offer = await this.offerRepo.findFirstBySellerAndExternalIdsWithModelRelations(
          seller.id,
          keys,
          [],
        );
        if (offer?.model) return false;
        const existing = await this.sourceRecordRepo.findBySourceAndUrl(
          context.source.id,
          normalizeUrl(context.url),
        );
        if (existing?.model) return false;
        if (existing) {
          // Saved without its loaded offers: a stale list would re-bind an
          // offer another writer has pointed at another record since.
          existing.offers = undefined;
        }

        const record = this.sourceRecordUpdater.upsertUnattached({
          existing,
          source: context.source,
          scrapedProduct: listing,
          externalId: listing.externalId,
          sourceUrl: context.url,
          normalizedSourceName: write.normalizedSourceName,
          feedRowHash: context.feedRowHash,
        });
        await this.sourceRecordRepo.save(record);
        this.productMetricsService.scrapeResolutionOutcome(context.source.name, 'unattached');
        this.logger.debug('No offer of the seller to join yet — stored unattached', {
          taskId: context.task?.id,
          url: context.url,
          source: context.source.name,
          externalIds: keys,
        });
        return true;
      },
    );
  }

  /**
   * This source's record of the page, when it sits on another product than the
   * one it now joins, or on any product while it joins none (its offer was
   * removed without detaching it): taken off that product, whose offers and
   * specs are then composed without it.
   */
  private async detachOwnRecordElsewhere(
    context: ProductImportContext,
    targetProductId: string | undefined,
  ): Promise<void> {
    const own = await this.sourceRecordRepo.findBySourceAndUrl(
      context.source.id,
      normalizeUrl(context.url),
    );
    const productId = own?.model?.id;
    if (!own || !productId || productId === targetProductId) return;

    await this.locks.withLocks([productLock(productId)], async () => {
      const model = await this.productRepo.findOneOrFail({
        where: { id: productId },
        relations: this.getProductRelations(),
      });
      const record = (model.sources ?? []).find((candidate) => candidate.id === own.id);
      if (!record) return;

      const keys = this.storedKeysOf(record);
      await this.contributorDetach.detachRecords(model, [record]);
      const { conflicts } = await this.offerComposer.compose({
        model,
        seller: context.source.seller,
        externalIds: keys,
        sighted: false,
        create: false,
      });
      this.reportConflicts(context, conflicts);
      await this.mergeService.recomputePrice(model);
      await this.productRepo.save(model);
      this.logger.log('A contributing listing left the product it had joined', {
        taskId: context.task?.id,
        url: context.url,
        source: context.source.name,
        productId,
        joins: targetProductId ?? null,
      });
    });
  }

  /**
   * This source's record of the page, when it waits unattached: brought onto
   * the product, so the write updates it instead of inserting a second record
   * of one (source, url).
   */
  private async adoptOwnRecord(
    context: ProductImportContext,
    model: ProductModel,
  ): Promise<void> {
    const url = normalizeUrl(context.url);
    const onProduct = (model.sources ?? []).some(
      (record) => record.source?.id === context.source.id && record.url === url,
    );
    if (onProduct) return;

    const own = await this.sourceRecordRepo.findBySourceAndUrl(context.source.id, url);
    if (!own) return;
    if (own.model) {
      throw new Error(
        `Listing ${url} of ${context.source.name} moved to product ${own.model.id} meanwhile; the task retries it`,
      );
    }
    own.offers = undefined;
    own.source = context.source;
    own.model = model;
    model.sources = [...(model.sources ?? []), own];
  }

  /**
   * The seller's records that waited unattached for one of this listing's
   * offers: rows of its sources that do not identify products, stored before
   * the offer existed. They join the product before its specs are merged and
   * its offers composed, so both include them. Under the product's lock and
   * the listing's offer keys (see storeUnattached).
   */
  private async attachWaitingRecords(
    write: ListingWrite,
    model: ProductModel,
  ): Promise<void> {
    const { context } = write;
    const waiting = await this.sourceRecordRepo.findUnattachedBySellerAndExternalIds(
      context.source.seller.id,
      uniq(compact(write.externalIds)),
    );
    if (isEmpty(waiting)) return;

    for (const record of waiting) record.model = model;
    model.sources = [...(model.sources ?? []), ...waiting];
    this.logger.log('Attached the listings that waited for this listing\'s offers', {
      taskId: context.task?.id,
      url: context.url,
      source: context.source.name,
      recordIds: waiting.map((record) => record.id),
    });
  }

  /**
   * The locks an identifying write holds: its product's, and its offer keys',
   * so a contributing listing of one of those offers waits until the offers
   * exist (see storeUnattached).
   */
  private writeLocks(write: ListingWrite, productId: string): AdvisoryLockKey[] {
    const sellerId = write.context.source.seller.id;
    return [
      productLock(productId),
      ...uniq(compact(write.externalIds)).map((key) => offerKeyLock(sellerId, key)),
    ];
  }

  /**
   * Which product this listing is, decided in tiers.
   *
   * 1. **Its own history** (resolved by the caller, before the extraction): a
   *    pinned task, one of its offers, or its record — this exact listing was
   *    seen before. Attaches without further checks.
   * 2. **Its identifiers**: a size its shop declares as a sibling, its GTIN,
   *    its MPN within the brand. The first tier that finds a product proposes
   *    it; the listing attaches if it passes the sanity check (same brand, no
   *    primary spec contradicting it). No LLM, no name scoring.
   * 3. **Name matching** (Path 4) for everything else, including listings whose
   *    identifiers conflicted.
   *
   * The identifier tiers are evaluated even when the listing's history
   * resolves it, because an identifier pointing at a DIFFERENT product is how a
   * duplicate created before the identifier was known comes to light. Those
   * become pairs after the save (recordKeyPairs); the listing never moves.
   */
  private async resolveProductIdentity(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    identifiers: OfferIdentifiers[],
    history: HistoryHit | undefined,
  ): Promise<{ identity: ResolvedIdentity; brandResolved: boolean }> {
    const brand = await this.brandResolution.resolve(
      scrapedProduct.brand,
      scrapedProduct.displayName,
    );
    const brandId = brand?.entity?.id;
    const brandResolved = !!brandId;
    const { keyMatches, verdict, keyGates } = await this.lookupKeys(
      context,
      scrapedProduct,
      identifiers,
      brandId,
    );

    if (history) {
      this.recordDisagreements(context, keyMatches, history.model.id, history.via);
      return {
        identity: { model: history.model, isExistingMatch: true, keyMatches, keyGates },
        brandResolved,
      };
    }

    if (verdict.kind === 'attach') {
      const model = await this.productRepo.findOneOrFail({
        where: { id: verdict.productId },
        relations: this.getProductRelations(),
      });
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        `${verdict.via}_hit`,
      );
      this.recordDisagreements(context, keyMatches, model.id, verdict.via);
      return {
        identity: { model, isExistingMatch: true, keyMatches, keyGates },
        brandResolved,
      };
    }

    if (verdict.kind === 'conflict') {
      this.productMetricsService.identityKeyConflict(
        context.source.name,
        verdict.via,
        verdict.reason,
      );
      this.logger.warn(
        'An identifier matched a product the listing cannot attach to — falling back to name matching',
        {
          taskId: context.task?.id,
          url: context.url,
          source: context.source.name,
          via: verdict.via,
          reason: verdict.reason,
          productIds: verdict.productIds,
        },
      );
    }

    // Path 4: match the listing against the stored catalog by name and specs.
    // Also the fallback for same-source variant siblings a source does not
    // declare — a source's own catalog legitimately accumulates several
    // ProductSourceRecords on one ProductModel (one per variant URL; see
    // §2.1a's offerLinks dispatch), so a same-source hit here is not
    // inherently a false positive.
    const { productId, decision } = await this.listingMatch.match(
      scrapedProduct,
      // Omitted rather than blank without a task (scripts, simulations): an
      // empty taskId in the logs would read as a lost one.
      context.task ? { taskId: context.task.id } : {},
    );

    if (productId) {
      const model = await this.productRepo.findOneOrFail({
        where: { id: productId },
        relations: this.getProductRelations(),
      });
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        decision.outcome === 'llm_identified' ? 'llm_identified' : 'identified',
      );
      this.productMetricsService.productMatched(context.source.name);
      return {
        identity: { model, isExistingMatch: true, decision, keyMatches, keyGates },
        brandResolved,
      };
    }

    // No match. `llm_declined` means the LLM actually looked at near-miss
    // candidates and wasn't confident — distinct from nothing being close
    // enough to be worth asking, which costs no call at all. A new product
    // either way (the safe default); the distinction measures how often
    // scoring leaves the LLM undecided.
    if (decision.llm) {
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        'llm_declined',
      );
    }

    return {
      identity: { isExistingMatch: false, decision, keyMatches, keyGates },
      brandResolved,
    };
  }

  /**
   * Every product one of the listing's identifiers points at, and whether the
   * first tier that found one lets the listing attach to it.
   */
  private async lookupKeys(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    identifiers: OfferIdentifiers[],
    brandId: string | undefined,
  ) {
    const keyMatches = await this.keyLookup.lookup({
      sourceId: context.source.id,
      // The listing's own id is its history, not a sibling of itself.
      siblingIds: (scrapedProduct.siblingExternalIds ?? []).filter(
        (id) => id !== scrapedProduct.externalId,
      ),
      gtins: compact(identifiers.map((identifier) => identifier.gtin)),
      mpns: compact(identifiers.map((identifier) => identifier.mpn)),
      brandId,
    });
    const { verdict, failedGates: keyGates } = await this.keyLookup.decide(
      keyMatches,
      {
        brandId,
        specs: scrapedProduct.specs,
        categorySlug: scrapedProduct.category.slug,
      },
    );
    return { keyMatches, verdict, keyGates };
  }

  /**
   * This listing's own record, when its history resolved it: the one this
   * scrape will overwrite, found by URL as the record updater does, else by
   * externalId. Read off the product's already-loaded sources — no query.
   */
  private ownRecordOf(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    model: ProductModel | undefined,
  ): ProductSourceRecord | undefined {
    const records = (model?.sources ?? []).filter(
      (record) => record.source?.id === context.source.id,
    );
    const url = normalizeUrl(context.url);
    return (
      records.find((record) => record.url === url) ??
      (scrapedProduct.externalId
        ? records.find((record) => record.externalId === scrapedProduct.externalId)
        : undefined)
    );
  }

  /**
   * Full spec unification, once per product per source: when this listing
   * creates its product, or is the first listing its source contributes to an
   * existing one. Every later size and every re-import of the source skips
   * it — the source's first record already carries what it adds. An admin's
   * forced resync is the exception: it re-reads that one listing in full.
   */
  private async unifyForNewSource(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    identity: ResolvedIdentity,
    brandResolved: boolean,
  ): Promise<ScrapedProduct> {
    const { model } = identity;
    const contributed = !!model?.sources?.some(
      (record) => record.source?.id === context.source.id,
    );
    if (contributed && !context.force) return scrapedProduct;
    // A product whose brand is unknown cannot be created, so the listing is
    // about to be dropped — not worth the most expensive call of the import.
    if (!model && !brandResolved) return scrapedProduct;

    return this.specPostProcess.unify({
      context,
      scrapedProduct,
      trigger: !model ? 'created' : contributed ? 'forced' : 'new_source',
    });
  }

  /**
   * This exact listing, seen before: its task was pinned to a product (Path 1),
   * one of its offers is already stored for this seller (Path 2), or this source
   * already has its record, by externalId (Path 3) or by page URL (Path 3b).
   * All are the listing's own history, so none needs checking against anything.
   */
  private async resolveFromHistory(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    seller: Seller,
  ): Promise<HistoryHit | undefined> {
    // Path 1: task already pinned to a product
    if (context.product?.id) {
      const model = await this.productRepo.findOneOrFail({
        where: { id: context.product.id },
        relations: this.getProductRelations(),
      });
      return { model, via: 'pinned' };
    }

    // Path 2: variant-level Offer.externalId reuse, multi-candidate — try
    // every offer's own externalId gathered by this scrape (the primary
    // page's offer plus any variant offers folded in by a multi-fetch
    // scrape) and take the first that matches an existing Offer for this
    // seller. Whichever variant URL we land on, and regardless of which
    // sibling's sku happens to already be in the DB, this resolves straight
    // back to the product we already created. Tried before Path 3's
    // group-level lookup because it's available whenever a source
    // identifies its listings at all (an offer's own sku), whereas the
    // group-level id is optional and only some sources populate it.
    const candidateExternalIds = compact(
      (scrapedProduct.offers ?? []).map((o) => o.externalId),
    );
    if (candidateExternalIds.length > 0) {
      const existingOffer =
        await this.offerRepo.findFirstBySellerAndExternalIdsWithModelRelations(
          seller.id,
          candidateExternalIds,
          this.getProductRelations(),
        );
      if (existingOffer?.model) {
        this.productMetricsService.scrapeResolutionOutcome(
          context.source.name,
          'offer_external_id_hit',
        );
        return { model: existingOffer.model, via: 'offer_external_id' };
      }
    }

    // Path 3: this exact (source, externalId) listing was already scraped
    // and linked to a product — reuse that link directly. externalId is a
    // group-level id (e.g. ShopRenter's parent.sku), stable across URL,
    // variant, and display-name changes. Only reached when Path 2 found no
    // offer-level match (either no offer externalId matched, or this scrape
    // carries none at all).
    if (scrapedProduct.externalId) {
      const existingSource =
        await this.sourceRecordRepo.findBySourceAndExternalIdWithModelRelations(
          context.source.id,
          scrapedProduct.externalId,
          this.getProductRelations(),
        );
      if (existingSource?.model) {
        this.productMetricsService.scrapeResolutionOutcome(
          context.source.name,
          'external_id_hit',
        );
        return { model: existingSource.model, via: 'external_id' };
      }
    }

    // Path 3b: this source already has a record for this very page. The only
    // history a source without source-native ids has, and what lets its
    // unchanged listings skip the extraction on a re-import.
    const byUrl = await this.sourceRecordRepo.findBySourceAndUrl(
      context.source.id,
      normalizeUrl(context.url),
    );
    if (byUrl?.model) {
      const model = await this.productRepo.findOneOrFail({
        where: { id: byUrl.model.id },
        relations: this.getProductRelations(),
      });
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        'source_url_hit',
      );
      return { model, via: 'source_url' };
    }

    return undefined;
  }

  /**
   * Counts every identifier tier that points at another product than the one
   * this listing resolved to. The listing stays put — an earlier tier is the
   * stronger evidence — and the pair written after the save is how a person
   * finds the duplicate.
   */
  private recordDisagreements(
    context: ProductImportContext,
    keyMatches: KeyMatch[],
    productId: string,
    resolvedVia: IdentityResolvedVia,
  ): void {
    const identifierTier = ['sibling', 'gtin', 'mpn'].includes(resolvedVia)
      ? (resolvedVia as IdentifierTier)
      : undefined;
    for (const via of this.keyLookup.disagreeingTiers(
      keyMatches,
      productId,
      identifierTier,
    )) {
      this.productMetricsService.identityKeyDisagreement(
        context.source.name,
        resolvedVia,
        via,
      );
    }
  }

  /**
   * Writes the listing onto an existing product, under the product's lock.
   *
   * Identity was decided before the lock, on a copy of the product that may
   * be seconds old by now. It is loaded again under the lock, so nothing
   * another import wrote since — a listing, an offer, a split that moved a
   * record away — is saved over or re-bound.
   */
  private async attachToProduct(
    write: ListingWrite,
    identity: ResolvedIdentity,
    productId: string,
  ): Promise<WrittenListing> {
    const model = await this.locks.withLocks(this.writeLocks(write, productId), async () => {
      const model = await this.productRepo.findOneOrFail({
        where: { id: productId },
        relations: this.getProductRelations(),
      });
      const written = await this.writeListing(write, model, identity);
      await this.copyFirstImage(write, model);
      await this.createOrUpdateOffers({ write, model, ...written });
      return model;
    });
    return { model, identity, created: false };
  }

  /**
   * Creates the product the listing resolved to none of.
   *
   * Two listings of one new bike (two sizes, or two shops) imported at once
   * both decide to create it. Creation is therefore serialized per brand, and
   * each creator re-checks under the brand's lock, with the same
   * deterministic tiers and no LLM: the second finds what the first created
   * and attaches to it. The lock is held until the offers are written,
   * because the GTIN and MPN tiers find a product through its offers.
   */
  private async createProduct(
    write: ListingWrite,
    identity: ResolvedIdentity,
  ): Promise<WrittenListing> {
    const { context } = write;
    // Before any lock: the shell costs an embedding call, thrown away when
    // the re-check attaches.
    const shell = await this.newProductModel(
      context,
      write.listing,
      write.normalizedSourceName,
    );

    const written = await this.locks.withLocks(
      [brandLock(shell.brand.id)],
      async () => {
        const recheck = await this.recheckIdentity(write, shell.brand.id);
        const rechecked: ResolvedIdentity = {
          ...identity,
          keyMatches: recheck.keyMatches,
          keyGates: recheck.keyGates,
        };
        if (!recheck.found) {
          return this.insertProduct(write, rechecked, shell);
        }

        this.productMetricsService.identityRecheckAttached(
          context.source.name,
          recheck.found.via,
        );
        this.logger.log(
          'A concurrent import created this product first — attaching instead of creating',
          {
            taskId: context.task?.id,
            url: context.url,
            source: context.source.name,
            productId: recheck.found.productId,
            via: recheck.found.via,
          },
        );
        return this.attachToProduct(
          write,
          {
            ...rechecked,
            isExistingMatch: true,
            decision: recheck.found.decision,
          },
          recheck.found.productId,
        );
      },
    );

    if (written.created) {
      // After the brand's lock: the copy is an upload, and nothing about the
      // brand depends on it. Re-loaded, because a listing that attached since
      // may have brought the product its image already.
      await this.locks.withLocks([productLock(written.model.id)], async () => {
        const model = await this.productRepo.findOneOrFail({
          where: { id: written.model.id },
          relations: this.getProductRelations(),
        });
        await this.copyFirstImage(write, model);
      });
    }
    return written;
  }

  /**
   * The identity decision again, under the brand's lock: the listing's own
   * history, its identifiers, then name matching without the LLM. Queries
   * only, no calls. It finds what a concurrent import of the same bike
   * created after this listing decided to create one.
   */
  private async recheckIdentity(
    write: ListingWrite,
    brandId: string,
  ): Promise<Recheck> {
    const { context, extracted, identifiers } = write;
    const history = await this.resolveFromHistory(
      context,
      extracted,
      context.source.seller,
    );
    const { keyMatches, verdict, keyGates } = await this.lookupKeys(
      context,
      extracted,
      identifiers,
      brandId,
    );

    if (history) {
      return {
        keyMatches,
        keyGates,
        found: { productId: history.model.id, via: history.via },
      };
    }
    if (verdict.kind === 'attach') {
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        `${verdict.via}_hit`,
      );
      return {
        keyMatches,
        keyGates,
        found: { productId: verdict.productId, via: verdict.via },
      };
    }

    const { productId, decision } = await this.listingMatch.match(
      extracted,
      context.task ? { taskId: context.task.id } : {},
      { llm: false },
    );
    if (!productId) {
      return { keyMatches, keyGates };
    }
    this.productMetricsService.scrapeResolutionOutcome(
      context.source.name,
      'identified',
    );
    return {
      keyMatches,
      keyGates,
      found: { productId, via: 'name', decision },
    };
  }

  /**
   * Inserts the new product with the listing's record, aliases and offers,
   * under the brand's lock and its own. The id is chosen here rather than by
   * the insert, because the product's lock is keyed by it.
   */
  private async insertProduct(
    write: ListingWrite,
    identity: ResolvedIdentity,
    shell: ProductModel,
  ): Promise<WrittenListing> {
    const id = randomUUID();
    return this.locks.withLocks(this.writeLocks(write, id), async () => {
      const written = await this.writeListing(write, shell, identity, id);
      this.productMetricsService.scrapeResolutionOutcome(
        write.context.source.name,
        'created',
      );
      await this.createOrUpdateOffers({ write, model: shell, ...written });
      return { model: shell, identity, created: true };
    });
  }

  /**
   * The listing's record, the product's specs and names recomputed from all
   * its records, the save, and the listing's aliases. Runs under the
   * product's lock, on a product loaded under it or on the new one.
   *
   * `newId` marks a product being created. It is assigned only after the name
   * merge, which inserts aliases for products that already have a row and
   * skips a product without an id.
   *
   * Also answers which offers the listing's record carried before this write,
   * so the offers it no longer shows can be dealt with.
   */
  private async writeListing(
    write: ListingWrite,
    model: ProductModel,
    identity: ResolvedIdentity,
    newId?: string,
  ): Promise<{
    sourceRecord: ProductSourceRecord | undefined;
    previousExternalIds: string[];
  }> {
    const { context, listing, normalizedSourceName } = write;
    const previousExternalIds = this.storedExternalIdsOf(context, model);

    this.applyScrapedProductDetails(model, listing);
    // Before the listing's own record: when its source used to contribute
    // only, its record is among them, and is updated rather than duplicated.
    await this.attachWaitingRecords(write, model);

    const sourceRecord = await this.sourceRecordUpdater.upsertSourceRecord({
      model,
      scrapedProduct: listing,
      externalId: listing.externalId,
      source: context.source,
      sourceUrl: context.url,
      normalizedSourceName,
      feedRowHash: context.feedRowHash,
    });

    // model.productCategory may only be the { id } stub set by
    // newProductModel/applyScrapedProductDetails — pass the slug explicitly
    // from ScrapedProduct.category, which is always fully populated.
    await this.mergeService.mergeSources(model, listing.category.slug);

    if (newId) {
      model.id = newId;
    }
    // Before the save, so a new product is inserted with its slug in one
    // statement.
    if (!model.slug) {
      await this.generateProductSlug(model);
    }
    await this.productRepo.save(model);

    if (newId) {
      this.productMetricsService.newProductCreated(context.source.name);
    } else {
      this.productMetricsService.productUpdated(context.source.name);
    }

    await this.writeBackToTask(context, model, identity.decision);

    // Source-provided aliases (e.g. DisplaySpecs "Model alias" list,
    // Árukereső parenthesized part numbers). After the save, so a new
    // product has its row.
    const insertedCount = await this.createNewAliases(
      model,
      [...(listing.aliases ?? [])],
      ProductAliasSource.scraped,
      context.source?.id,
    );
    if (insertedCount > 0) {
      this.productMetricsService.productAliasCreated(
        context.source.name,
        insertedCount,
      );
    }

    return { sourceRecord, previousExternalIds };
  }

  /** The product the listing was written to, onto its task. */
  private async writeBackToTask(
    context: ProductImportContext,
    model: ProductModel,
    decision?: ListingMatchDecision,
  ): Promise<void> {
    // Every import runs in a task now; only scripts and simulations call without.
    context.product = model;
    if (context.task) {
      context.task.product = model;
      if (decision) {
        context.task.identityDecision = decision;
      }
      await this.taskRepo.save(context.task);
    }
  }

  /**
   * The externalIds this source's record of this page carries now — found the
   * way the record updater finds the record it overwrites.
   */
  private storedExternalIdsOf(
    context: ProductImportContext,
    model: ProductModel,
  ): string[] {
    const url = normalizeUrl(context.url);
    const record = (model.sources ?? []).find(
      (candidate) => candidate.source?.id === context.source.id && candidate.url === url,
    );
    return record ? this.storedKeysOf(record) : [];
  }

  /** The externalIds a record's offers are stored under. */
  private storedKeysOf(record: ProductSourceRecord): string[] {
    return uniq(
      compact(
        (record.scrapedProduct?.offers ?? []).map((entry) =>
          storedOfferExternalId(record, entry),
        ),
      ),
    );
  }

  /**
   * The listing's offers as its record keeps them: each with the externalId
   * its offer is stored under (null where ids collided), and the page's
   * offer-level specs where it has none of its own. The record alone is then
   * enough to compose the offer from (OfferComposerService).
   */
  private withStoredOffers(
    listing: ScrapedProduct,
    externalIds: (string | undefined)[],
  ): ScrapedProduct {
    if (isEmpty(listing.offers)) return listing;
    const offerLevelKeys =
      this.categoryConfigService.getConfig(listing.category?.slug)?.offerLevelSpecs ?? [];
    const pageOfferLevelSpecs = pick(filterDefinedSpecs(listing.specs ?? {}), offerLevelKeys);
    return {
      ...listing,
      offers: (listing.offers ?? []).map((offer, index) => ({
        ...offer,
        resolvedExternalId: externalIds[index] ?? null,
        specs: offer.specs ?? pageOfferLevelSpecs,
      })),
    };
  }

  /**
   * Only the first source scraped for a product supplies its image — once
   * model.images is non-empty, later sources' images are never copied or
   * considered, by design (single main image per product, not a multi-source
   * gallery).
   */
  private async copyFirstImage(
    write: ListingWrite,
    model: ProductModel,
  ): Promise<void> {
    if (!isEmpty(model.images)) return;

    const { context, listing } = write;
    const firstImage = minBy(listing.images ?? [], (img) => img.order);
    const newImages = firstImage
      ? await this.imageCopyService.copyImagesFromSource(model, context.source, [
          firstImage.url,
        ])
      : [];
    model.images = [...(model.images ?? []), ...newImages];

    if (!model.mainImage) {
      const mainImage = minBy(model.images ?? [], (img) => img.order);
      if (mainImage) {
        model.mainImage = mainImage;
        await this.productRepo.save(model);

        this.productMetricsService.productImagesCreated(
          context.source.name,
          newImages.length,
        );
      }
    }
  }

  /**
   * Pairs this listing's product with every other product one of its
   * identifiers points at. Never fails the scrape, for the same reason
   * detectDuplicates doesn't.
   */
  private async recordKeyPairs(
    context: ProductImportContext,
    model: ProductModel,
    identity: ResolvedIdentity,
  ): Promise<void> {
    try {
      await this.keyLookup.recordPairs(
        model.id,
        identity.keyMatches,
        identity.keyGates,
        'scrape',
      );
    } catch (error) {
      this.logger.warn('Recording identifier duplicate pairs failed, continuing', {
        taskId: context.task?.id,
        productId: model.id,
        error,
      });
    }
  }

  /**
   * Only after Path 4, where a listing's identity was decided by scoring rather
   * than by a stored id. This is also where two products that both matched the
   * listing become a pair for someone to look at. Never fails the scrape: the
   * product and its offers are already saved, and a missing suggestion is worth
   * far less than a lost scrape.
   */
  private async detectDuplicates(
    context: ProductImportContext,
    model: ProductModel,
  ): Promise<void> {
    try {
      await this.duplicateService.detect(model.id, 'scrape');
    } catch (error) {
      this.logger.warn('Duplicate detection failed, continuing', {
        taskId: context.task?.id,
        productId: model.id,
        error,
      });
    }
  }

  /**
   * The listing's offers, composed from every current record of the seller —
   * this listing's own record was written just before, under the same lock.
   * Which source imported last no longer decides what an offer says: a
   * higher-priority source's value wins field by field (OfferComposerService).
   *
   * No-op for sources whose config doesn't populate ScrapedProduct.offers.
   */
  private async createOrUpdateOffers(params: {
    write: ListingWrite;
    model: ProductModel;
    sourceRecord: ProductSourceRecord | undefined;
    previousExternalIds: string[];
  }): Promise<void> {
    const { write, model, sourceRecord, previousExternalIds } = params;
    const { context, listing, externalIds } = write;
    if (isEmpty(listing.offers)) return;

    if (!sourceRecord) {
      this.logger.warn(
        'No ProductSourceRecord resolved for this scrape, skipping offer upsert',
        { taskId: context.task?.id, url: context.url },
      );
      return;
    }

    const keyed = uniq(compact(externalIds));
    const composed = await this.offerComposer.compose({
      model,
      seller: context.source.seller,
      externalIds: keyed,
      sighted: true,
      create: true,
    });
    this.reportConflicts(context, composed.conflicts);
    const unkeyed = await this.writeUnkeyedOffers(write, model, sourceRecord);

    // Nothing written at all (every offer refused or failed) is no evidence
    // about what the page stopped showing.
    const written = composed.offers.length + unkeyed;
    if (written === 0) return;

    await this.dealWithDroppedOffers({
      context,
      model,
      dropped: difference(previousExternalIds, keyed),
    });
    await this.mergeService.recomputePrice(model);
    await this.productRepo.save(model);
  }

  /**
   * Offers this listing's record carried and no longer does. One no other
   * current record of the seller carries is gone from the shop and deleted at
   * once, and the contributing records that joined only it are detached; one
   * another source still lists is composed again without this listing's
   * values. Offers on pages this import did not visit are left to their own
   * imports, and to the stale-offer sweep.
   */
  private async dealWithDroppedOffers(params: {
    context: ProductImportContext;
    model: ProductModel;
    dropped: string[];
  }): Promise<void> {
    const { context, model, dropped } = params;
    if (isEmpty(dropped)) return;
    const seller = context.source.seller;

    const stillListed = dropped.filter(
      (externalId) =>
        !isEmpty(
          this.offerComposer.currentCarriers({ model, sellerId: seller.id, externalId }),
        ),
    );
    const gone = difference(dropped, stillListed);

    if (!isEmpty(stillListed)) {
      const recomposed = await this.offerComposer.compose({
        model,
        seller,
        externalIds: stillListed,
        sighted: false,
        create: false,
      });
      this.reportConflicts(context, recomposed.conflicts);
    }
    if (!isEmpty(gone)) {
      const offers = (
        await this.offerRepo.findBySellerAndExternalIds(seller.id, gone)
      ).filter((offer) => offer.model?.id === model.id);
      if (isEmpty(offers)) return;
      await this.offerRepo.deleteByIds(offers.map((offer) => offer.id));
      await this.contributorDetach.detach({
        model,
        sellerId: seller.id,
        externalIds: compact(offers.map((offer) => offer.externalId)),
      });
    }
  }

  /**
   * Offers without an externalId — several on one page collided on it (see
   * resolveOfferExternalIds). Nothing joins another source to such an offer,
   * so each is written from its own entry, matched within this source's own
   * offers as before; this record's other unkeyed offers not matched this
   * round are gone from its page. Returns how many were written.
   */
  private async writeUnkeyedOffers(
    write: ListingWrite,
    model: ProductModel,
    sourceRecord: ProductSourceRecord,
  ): Promise<number> {
    const { context, listing, externalIds } = write;
    const entries = (listing.offers ?? []).filter((_, index) => !externalIds[index]);
    if (isEmpty(entries)) return 0;

    const seller = context.source.seller;
    const preloaded = (
      await this.offerRepo.findAllByModelAndSource(model.id, context.source.id)
    ).filter((offer) => !offer.externalId);

    const written: Offer[] = [];
    for (const entry of entries) {
      try {
        written.push(
          await this.offerComposer.writeUnkeyed({
            existing: this.offerMatching.findMatch(preloaded, entry, seller.id),
            model,
            seller,
            record: sourceRecord,
            entry,
          }),
        );
      } catch (error) {
        // Do not fail the whole product scrape if one offer fails — mirrors
        // the existing brand-resolution-failure tolerance in this service.
        this.logger.warn('Failed to upsert offer, continuing', {
          taskId: context.task?.id,
          url: context.url,
          error,
        });
      }
    }

    if (!isEmpty(written)) {
      const matchedIds = new Set(written.map((offer) => offer.id));
      const staleIds = preloaded
        .filter(
          (offer) =>
            !matchedIds.has(offer.id) && offer.sourceRecord?.id === sourceRecord.id,
        )
        .map((offer) => offer.id);
      if (!isEmpty(staleIds)) await this.offerRepo.deleteByIds(staleIds);
    }
    return written.length;
  }

  /**
   * An identity disagreement is not a flaky write — two sources have resolved
   * different products for one seller listing, and one of them is wrong. It
   * must not abandon the rest of the page, but it is logged as an error and
   * counted, because the alternative is a product quietly sitting with no
   * offer and therefore no price.
   */
  private reportConflicts(
    context: ProductImportContext,
    conflicts: OfferIdentityConflictError[],
  ): void {
    for (const conflict of conflicts) {
      this.logger.error(
        'Offer identity disagreement between sources — refusing to rebind the offer',
        conflict,
        {
          taskId: context.task?.id,
          url: context.url,
          source: context.source.name,
          ...conflict.details,
        },
      );
      this.productMetricsService.offerIdentityConflict(
        context.source.name,
        'model_disagreement',
      );
    }
  }

  /**
   * The `Offer.externalId` for every offer on this page, resolved together.
   *
   * Two jobs, and the second is why this cannot be done per offer.
   *
   * **The fallback.** A source-native id when there is one, otherwise the URL
   * slug. Derived here, in shared code, rather than per config — that is what
   * guarantees a scraping source and an Árukereső source for the same shop land
   * on the same string, which is the whole mechanism by which two sources
   * converge on one offer (the `(seller, externalId)` unique constraint).
   *
   * **The collision guard.** Uniqueness is a property of the set, not of any
   * one offer. A page listing several size variants at one URL gives every one
   * of them the same slug, and the unique constraint does not error on that —
   * it keeps the last writer, so the page silently ends up with ONE offer where
   * it should have four, and `upsertedOffers` holds the same id N times. Any
   * value claimed by more than one offer is therefore dropped for all of them:
   * an offer with no externalId falls back to OfferMatchingService within this
   * source's own preload, which is how sources with no ids at all have always
   * worked — strictly better than losing variants.
   *
   * A collision between SOURCE-NATIVE ids is a different thing from a collision
   * between fallbacks — the first is a config emitting a group-level id where a
   * variant-level one was needed, the second is just a page shape — so they are
   * logged and counted separately.
   */
  private resolveOfferExternalIds(
    context: ProductImportContext,
    offers: ScrapedOffer[],
  ): (string | undefined)[] {
    const resolved = offers.map((scraped) =>
      offerExternalIdOf(scraped, context.url),
    );

    const counts = new Map<string, number>();
    for (const { value } of resolved) {
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const reported = new Set<string>();

    return resolved.map(({ value, native }) => {
      if (!value || (counts.get(value) ?? 0) === 1) return value;

      const kind = native ? 'duplicate_external_id' : 'duplicate_slug_fallback';
      if (!reported.has(value)) {
        reported.add(value);
        this.logger.error(
          native
            ? 'Several offers on one page share a source-native externalId — dropping it for all of them, because keeping it would collapse them into one Offer row. The source must emit a variant-level id.'
            : 'Several offers on one page fall back to the same URL slug — dropping it for all of them, because keeping it would collapse them into one Offer row. This page needs per-offer externalIds.',
          undefined,
          {
            taskId: context.task?.id,
            url: context.url,
            source: context.source.name,
            externalId: value,
            offers: counts.get(value),
          },
        );
        this.productMetricsService.offerIdentityConflict(
          context.source.name,
          kind,
        );
      }

      return undefined;
    });
  }

  /**
   * Every offer's GTIN and MPN in the form Offer stores and matches on.
   *
   * An invalid GTIN is dropped rather than stored, because a GTIN is matched
   * against every shop's offers and a wrong one would attach this listing to a
   * different bike. The raw value stays on the source record's scrapedProduct;
   * the outcome of every offer's GTIN is counted, so a source whose barcodes
   * stop validating shows up as a rate rather than as missing matches.
   */
  private normalizeOfferIdentifiers(
    context: ProductImportContext,
    offers: ScrapedOffer[],
  ): OfferIdentifiers[] {
    return offers.map((scraped) => {
      const { gtin, outcome } = inspectGtin(scraped.gtin);
      this.productMetricsService.offerGtin(context.source.name, outcome);
      if (outcome === 'invalid') {
        this.logger.debug('Dropping an invalid GTIN', {
          taskId: context.task?.id,
          url: context.url,
          source: context.source.name,
          gtin: scraped.gtin,
        });
      }
      return { gtin, mpn: normalizeMpn(scraped.mpn) };
    });
  }

  private async createNewAliases(
    model: ProductModel,
    aliases: string[],
    source: ProductAliasSource,
    sourceRefId?: string,
  ): Promise<number> {
    const normalizedAliases = [
      ...new Set(aliases.map(normalize).filter(Boolean)),
    ];
    const candidates = normalizedAliases.map((alias) => {
      const entity = new ProductAlias();
      entity.model = model;
      entity.alias = alias;
      entity.source = source;
      entity.sourceRefId = sourceRefId;
      return entity;
    });

    if (candidates.length === 0) return 0;

    // ON CONFLICT on the composite (model, alias) index — dedupes per product
    // while allowing the same alias string across different products.
    const result = await this.aliasRepo.repo
      .createQueryBuilder()
      .insert()
      .into(ProductAlias)
      .values(candidates)
      .orIgnore()
      .returning('id')
      .execute();

    return result.generatedMaps.length || result.identifiers.length;
  }

  private applyScrapedProductDetails(
    model: ProductModel,
    scrapedProduct: ScrapedProduct,
  ): void {
    if (scrapedProduct.displayName) {
      model.displayName = scrapedProduct.displayName;
    }
    if (scrapedProduct.model) {
      model.model = scrapedProduct.model;
    }

    // Only replace productCategory when it's actually changing — it's normally
    // the fully-loaded entity fetched via getProductRelations(), and a bare
    // { id } stub here (TypeORM only needs the id for the FK save) is fine
    // since mergeSources takes categorySlug as an explicit parameter rather
    // than reading it off this relation.
    if (model.productCategory?.id !== scrapedProduct.category.id) {
      model.productCategory = { id: scrapedProduct.category.id } as ProductCategory;
    }
  }

  private getProductRelations(): string[] {
    return [
      nameOf<ProductModel>('productCategory'),
      nameOf<ProductModel>('mainImage'),
      nameOf<ProductModel>('images'),
      nameOf<ProductModel>('embedding'),
      nameOf<ProductModel>('sources'),
      `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
      // The offers are composed from the seller's records (OfferComposerService).
      `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}.${nameOf<ProductSource>('seller')}`,
    ];
  }

  private async generateProductSlug(entity: ProductModel): Promise<void> {
    const brandName = entity.brand?.name ?? '';
    let slug = generateSlug(
      entity.id,
      brandName,
      entity.model || entity.displayName,
    );
    const existing = await this.productRepo.findOne({
      where: { slug },
      select: ['id'],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + '-' + entity.id.slice(-6);
    }
    entity.slug = slug;
  }

  private async newProductModel(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    normalizedSourceName: string,
  ): Promise<ProductModel> {
    try {
      return await this.modelFactory.createShell({
        brandName: scrapedProduct.brand,
        displayName: scrapedProduct.displayName,
        model: scrapedProduct.model,
        categoryId: scrapedProduct.category.id,
        categoryName: scrapedProduct.category.name,
        normalizedName: normalizedSourceName,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === BRAND_NOT_IDENTIFIED) {
        this.logger.warn(
          'Brand could not be identified, skipping product creation',
          {
            taskId: context.task?.id,
            url: context.url,
            displayName: scrapedProduct.displayName,
          },
        );
      }
      throw error;
    }
  }
}
