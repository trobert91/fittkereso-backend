import { Injectable } from '@nestjs/common';
import {
  Offer,
  OfferRepository,
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapeTask,
  OfferIdentityConflictError,
  ScrapeTaskRepository,
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
  generateSlug,
  nameOf,
  normalize,
  inspectGtin,
  normalizeMpn,
  normalizeUrl,
  slugFromUrl,
} from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BRAND_NOT_IDENTIFIED,
  BrandResolutionService,
  OfferMatchingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductModelFactoryService,
  ProductNormalizerService,
  ProductSourceRecordUpdaterService,
} from '@fittkereso-backend/product';
import { ScrapedOffer, ScrapedProduct } from '@fittkereso-backend/product';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';
import { compact, isEmpty, minBy, pick } from 'lodash';
import { SpecPostProcessService } from './spec-post-process.service';
import {
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

interface PersistResult {
  model: ProductModel;
  created: boolean;
  sourceRecord?: ProductSourceRecord;
}

@Injectable()
export class ProductScrapeUpdaterService {
  private readonly logger = new CustomLogger(ProductScrapeUpdaterService.name);

  constructor(
    private readonly listingMatch: ListingMatchService,
    private readonly duplicateService: ProductDuplicateService,
    private readonly modelFactory: ProductModelFactoryService,
    private readonly productRepo: ProductModelRepository,
    private readonly taskRepo: ScrapeTaskRepository,
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

      const normalizedSourceName = this.buildNormalizedSourceName(listing);
      const persisted = await this.persistProduct({
        context,
        scrapedProduct: listing,
        normalizedSourceName,
        identity,
      });
      await this.applyPostSaveSideEffects({
        context,
        scrapedProduct: listing,
        model: persisted.model,
        sourceRecord: persisted.sourceRecord,
        identity,
        identifiers,
      });
      return persisted.model;
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
      // Omitted rather than blank on the feed path: there is no task, and an
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

  private async persistProduct(params: {
    context: ProductImportContext;
    scrapedProduct: ScrapedProduct;
    normalizedSourceName: string;
    identity: ResolvedIdentity;
  }): Promise<PersistResult> {
    const { context, scrapedProduct, normalizedSourceName, identity } = params;

    let model = identity.model;
    if (!model) {
      model = await this.newProductModel(
        context,
        scrapedProduct,
        normalizedSourceName,
      );
      this.productMetricsService.scrapeResolutionOutcome(
        context.source.name,
        'created',
      );
    }

    this.applyScrapedProductDetails(model, scrapedProduct);

    const sourceRecord = await this.sourceRecordUpdater.upsertSourceRecord({
      model,
      scrapedProduct,
      externalId: scrapedProduct.externalId,
      source: context.source,
      sourceUrl: context.url,
      normalizedSourceName,
    });

    // model.productCategory may only be the { id } stub set by
    // newProductModel/applyScrapedProductDetails — pass the slug explicitly
    // from ScrapedProduct.category, which is always fully populated.
    await this.mergeService.mergeSources(model, scrapedProduct.category.slug);

    const saveOutcome = await this.saveProductModel({ model });
    saveOutcome.sourceRecord ??= sourceRecord;

    if (saveOutcome.created) {
      this.productMetricsService.newProductCreated(context.source.name);
    } else {
      this.productMetricsService.productUpdated(context.source.name);
    }

    // Only the scrape path has a task to write back to; a feed run does not.
    context.product = saveOutcome.model;
    if (context.task) {
      context.task.product = saveOutcome.model;
      if (identity.decision) {
        context.task.identityDecision = identity.decision;
      }
      await this.taskRepo.save(context.task);
    }

    return saveOutcome;
  }

  private async applyPostSaveSideEffects(params: {
    context: ProductImportContext;
    scrapedProduct: ScrapedProduct;
    model: ProductModel;
    sourceRecord?: ProductSourceRecord;
    identity: ResolvedIdentity;
    identifiers: OfferIdentifiers[];
  }): Promise<void> {
    const { context, scrapedProduct, model, sourceRecord, identity, identifiers } =
      params;

    if (!model.slug) {
      await this.generateProductSlug(model);
      await this.productRepo.save(model);
    }

    // Save source-provided aliases (e.g. DisplaySpecs "Model alias" list,
    // Árukereső parenthesized part numbers). Must run after save so new products have an id.
    const aliasCandidates = [...(scrapedProduct.aliases ?? [])];
    const insertedCount = await this.createNewAliases(
      model,
      aliasCandidates,
      ProductAliasSource.scraped,
      context.source?.id,
    );
    if (insertedCount > 0) {
      this.productMetricsService.productAliasCreated(
        context.source.name,
        insertedCount,
      );
    }

    // Only the first source scraped for a product supplies its image — once
    // model.images is non-empty, later sources' images are never copied or
    // considered, by design (single main image per product, not a
    // multi-source gallery).
    if (isEmpty(model.images)) {
      const firstImage = minBy(scrapedProduct.images ?? [], (img) => img.order);
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

    await this.createOrUpdateOffers(
      context,
      scrapedProduct,
      model,
      sourceRecord,
      identifiers,
    );

    if (identity.decision) {
      await this.detectDuplicates(context, model);
    }
    // After name-based detection, so where both found the same pair the
    // identifier — the stronger evidence — is what the pair shows.
    await this.recordKeyPairs(context, model, identity);
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

  // No-op for sources whose config doesn't populate ScrapedProduct.offers.
  // Each offer can carry its own `url` (a multi-seller/multi-listing page's
  // itemPipeline can stamp a distinct URL per offer) — a ProductSourceRecord
  // represents one URL, so sourceRecord is resolved per offer here rather
  // than passed as one shared value, falling back to the primary page's own
  // sourceRecord (the ordinary single-offer-per-page case, and the
  // shared-URL multi-seller-table case).
  private async createOrUpdateOffers(
    context: ProductImportContext,
    scrapedProduct: ScrapedProduct,
    model: ProductModel,
    primarySourceRecord: ProductSourceRecord | undefined,
    identifiers: OfferIdentifiers[],
  ): Promise<void> {
    const offers = scrapedProduct.offers;
    if (isEmpty(offers)) return;

    if (!primarySourceRecord) {
      this.logger.warn(
        'No ProductSourceRecord resolved for this scrape, skipping offer upsert',
        { taskId: context.task?.id, url: context.url },
      );
      return;
    }

    // Page-level offer-level specs (e.g. frameSize, color), derived from the
    // primary page's own spec set. Applied to every offer on the page by
    // default; an individual ScrapedOffer.specs overrides this for sources
    // that report multiple size/color variants, each with its own price.
    // Always optional — a listing with no extractable offer-level values
    // simply yields {}.
    const offerLevelKeys =
      this.categoryConfigService.getConfig(scrapedProduct.category?.slug)
        ?.offerLevelSpecs ?? [];
    const pageOfferLevelSpecs = pick(
      primarySourceRecord.scrapedProduct?.specs,
      offerLevelKeys,
    );

    // Scoped by source, not by a single sourceRecord — a multi-variant
    // scrape persists offers under several ProductSourceRecords for this
    // source (one per URL), and two independently enqueued tasks can each
    // create their own record for overlapping variants. Preloading by
    // source lets OfferMatchingService find and update an offer regardless
    // of which record originally created it.
    const preloadedOffers = await this.offerRepo.findAllByModelAndSource(
      model.id,
      context.source.id,
    );

    const upsertedOffers: Offer[] = [];
    // Every ProductSourceRecord this scrape actually produced an offer for —
    // the only records whose offers this pass is entitled to judge as
    // stale. A scrape of one variant URL never visits a sibling variant's
    // own page (each variant is now its own independently scheduled
    // ScrapeTask), so it has no way to know whether that sibling's own offer
    // is still live; only records this pass actually touched get their
    // unmatched offers deleted.
    const touchedSourceRecordIds = new Set<string>();
    // Resolved for the whole page at once, because uniqueness is a property of
    // the SET, not of any one offer — see resolveOfferExternalIds.
    const externalIds = this.resolveOfferExternalIds(context, offers!);

    for (const [index, scraped] of offers!.entries()) {
      try {
        const normalizedScrapedUrl = scraped.url
          ? normalizeUrl(scraped.url)
          : undefined;
        // Scoped to this task's source: `model.sources` spans every source, and
        // record URLs are unique only per source, so a url-only match can
        // return another source's record. That would both misattribute this
        // offer's provenance and put the WRONG record id into
        // touchedSourceRecordIds below — leaving this source's own genuinely
        // stale offers permanently ineligible for the sweep.
        const sourceRecord = normalizedScrapedUrl
          ? (model.sources?.find(
              (s) =>
                s.source?.id === context.source.id &&
                s.url === normalizedScrapedUrl,
            ) ?? primarySourceRecord)
          : primarySourceRecord;
        touchedSourceRecordIds.add(sourceRecord.id);
        const seller = context.source.seller;
        const existing = this.offerMatching.findMatch(
          preloadedOffers,
          scraped,
          seller.id,
        );
        const offer = await this.offerRepo.upsertFromScrape({
          existing,
          model,
          seller,
          sourceRecord,
          price: scraped.price,
          priceWithoutDiscount: scraped.priceWithoutDiscount,
          currency: scraped.currency,
          availability: scraped.availability,
          url: normalizedScrapedUrl,
          externalId: externalIds[index],
          gtin: identifiers[index].gtin,
          mpn: identifiers[index].mpn,
          locations: scraped.locations,
          specs: scraped.specs ?? pageOfferLevelSpecs,
        });
        upsertedOffers.push(offer);
      } catch (error) {
        // An identity disagreement is not a flaky write — two sources have
        // resolved different products for one seller listing, and one of them
        // is wrong. It still must not abandon the rest of the page, but it is
        // logged as an error and counted, because the alternative is a product
        // quietly sitting with no offer and therefore no price.
        if (error instanceof OfferIdentityConflictError) {
          this.logger.error(
            'Offer identity disagreement between sources — refusing to rebind the offer',
            error,
            {
              taskId: context.task?.id,
              url: context.url,
              source: context.source.name,
              ...error.details,
            },
          );
          this.productMetricsService.offerIdentityConflict(
            context.source.name,
            'model_disagreement',
          );
          continue;
        }

        // Do not fail the whole product scrape if one offer fails — mirrors
        // the existing brand-resolution-failure tolerance in this service.
        this.logger.warn('Failed to upsert offer, continuing', {
          taskId: context.task?.id,
          url: context.url,
          error,
        });
      }
    }

    if (upsertedOffers.length > 0) {
      // Anything preloaded, belonging to a record this scrape actually
      // touched, but not matched this round is confirmed gone from that
      // record's page and is hard-deleted (not soft-deactivated) — see
      // OfferRepository/Offer.active doc comments. Offers on a
      // ProductSourceRecord this scrape never visited (a sibling variant's
      // own page) are left alone entirely — this pass has no evidence about
      // whether they're still live.
      const matchedIds = new Set(upsertedOffers.map((o) => o.id));
      const staleIds = preloadedOffers
        .filter(
          (o) =>
            !matchedIds.has(o.id) &&
            o.sourceRecord &&
            touchedSourceRecordIds.has(o.sourceRecord.id),
        )
        .map((o) => o.id);
      if (staleIds.length > 0) {
        await this.offerRepo.deleteByIds(staleIds);
      }
      await this.mergeService.recomputePrice(model);
      await this.productRepo.save(model);
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
    const resolved = offers.map((scraped) => {
      const native = scraped.externalId?.trim() || undefined;
      const url = scraped.url ? normalizeUrl(scraped.url) : context.url;
      return { value: native ?? slugFromUrl(url), native: !!native };
    });

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

  private async saveProductModel(params: {
    model: ProductModel;
  }): Promise<PersistResult> {
    const { model } = params;
    const isNewModel = !model.id;

    return {
      model: await this.productRepo.save(model),
      created: isNewModel,
    };
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
