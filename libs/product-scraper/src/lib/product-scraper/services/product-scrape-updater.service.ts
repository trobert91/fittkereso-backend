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
  ScrapeTaskRepository,
  Seller,
} from '@fittkereso-backend/database';
import {
  ResolutionContext,
  ResolutionResult,
  ResolutionService,
  productSpecsToStructuredSpecs,
} from '@fittkereso-backend/resolution';
import {
  generateSlug,
  nameOf,
  normalize,
  normalizeUrl,
} from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BRAND_NOT_IDENTIFIED,
  OfferMatchingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductModelFactoryService,
  ProductNormalizerService,
  ProductSourceRecordUpdaterService,
} from '@fittkereso-backend/product';
import { ScrapedProduct } from '@fittkereso-backend/product';
import { compact, isEmpty, minBy, pick } from 'lodash';
import { ProductMetricsService } from '@fittkereso-backend/metrics';

interface ResolvedIdentity {
  model?: ProductModel;
  isExistingMatch: boolean;
  resolutionContext?: ResolutionContext;
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
    private readonly productSearch: ResolutionService,
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
  ) {}

  public async createOrUpdateProduct(
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
  ): Promise<ProductModel | undefined> {
    if (!scrapedProduct.category?.id) {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        'skipped_no_category',
      );
      this.logger.warn('Skipping scrape — no category identified', {
        taskId: task.id,
        url: task.url,
        displayName: scrapedProduct.displayName,
      });
      return undefined;
    }

    try {
      const normalizedSourceName =
        this.buildNormalizedSourceName(scrapedProduct);
      // Every offer belongs to its ProductSource's own seller — no per-offer
      // seller resolution needed. Path 2 keys its (seller, externalId)
      // lookup off this.
      const seller = task.source.seller;
      const identity = await this.resolveProductIdentity(
        task,
        scrapedProduct,
        seller,
      );
      const persisted = await this.persistProduct({
        task,
        scrapedProduct,
        normalizedSourceName,
        identity,
      });
      await this.applyPostSaveSideEffects({
        task,
        scrapedProduct,
        model: persisted.model,
        sourceRecord: persisted.sourceRecord,
      });
      return persisted.model;
    } catch (error) {
      // do not fail the whole scraping if brand resolution fails
      if ((error as Error).message?.includes('Brand could not be identified')) {
        this.productMetricsService.productBrandResolutionFailed(
          task.source.name,
        );
        return undefined;
      }
      throw error;
    }
  }

  // One canonical name for this scrape, stored on the new ProductSourceRecord
  // row and used for ProductModel.normalizedName on new products.
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

  private async resolveProductIdentity(
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
    seller: Seller,
  ): Promise<ResolvedIdentity> {
    // Path 1: task already pinned to a product
    if (task.product?.id) {
      const model = await this.productRepo.findOneOrFail({
        where: { id: task.product.id },
        relations: this.getProductRelations(),
      });
      return { model, isExistingMatch: true };
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
          task.source.name,
          'offer_external_id_hit',
        );
        return { model: existingOffer.model, isExistingMatch: true };
      }
    }

    // Path 3: this exact (source, externalId) listing was already scraped
    // and linked to a product — reuse that link directly rather than
    // re-deriving identity from the name or falling through to the
    // matcher/embedding/LLM pipeline in Path 4. externalId is a group-level
    // id (e.g. ShopRenter's parent.sku), stable across URL, variant, and
    // display-name changes. Only reached when Path 2 found no offer-level
    // match (either no offer externalId matched, or this scrape carries
    // none at all).
    if (scrapedProduct.externalId) {
      const existingSource =
        await this.sourceRecordRepo.findBySourceAndExternalIdWithModelRelations(
          task.source.id,
          scrapedProduct.externalId,
          this.getProductRelations(),
        );
      if (existingSource?.model) {
        this.productMetricsService.scrapeResolutionOutcome(
          task.source.name,
          'external_id_hit',
        );
        return { model: existingSource.model, isExistingMatch: true };
      }
    }

    // Path 4: strict cross-source search. Also the fallback for same-source
    // variant siblings that carry no group-level externalId (Path 3) — a
    // source's own catalog legitimately accumulates several
    // ProductSourceRecords on one ProductModel (one per variant URL; see
    // §2.1a's offerLinks dispatch), so a same-source hit here is not
    // inherently a false positive. The engine already runs in `strict` mode
    // with brand/category/spec gates, so trusting it here is no weaker than
    // trusting it for cross-source matches.
    // Agent already filters candidates to category C via preResolvedCategories.
    //
    const resolved = await this.findExistingProductModel(task, scrapedProduct, {
      taskId: task.id,
    });
    const candidate = resolved.resolvedModel;
    const resolutionContext = resolved.context;

    if (candidate) {
      const isLlmMerge = resolutionContext?.decision?.kind === 'llm_resolved';
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        isLlmMerge ? 'llm_merge_accept' : 'cross_source_merge',
      );
      this.productMetricsService.productMatched(task.source.name);
      return {
        model: candidate,
        isExistingMatch: true,
        resolutionContext,
      };
    }

    // No accepted match. `llm_unresolved` means the scrape-merge LLM actually
    // looked at a near-miss candidate and wasn't confident — distinct from
    // `matcher_reject`, where it was never invoked because nothing was close
    // enough to be worth asking. The scraper creates a new product either way
    // (the safe default); the distinction is worth a metric because it measures
    // how often the matcher leaves the LLM undecided.
    if (resolutionContext?.decision?.kind === 'llm_unresolved') {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        'llm_merge_reject',
      );
    }

    return {
      isExistingMatch: false,
      resolutionContext,
    };
  }

  private async persistProduct(params: {
    task: ScrapeTask;
    scrapedProduct: ScrapedProduct;
    normalizedSourceName: string;
    identity: ResolvedIdentity;
  }): Promise<PersistResult> {
    const { task, scrapedProduct, normalizedSourceName, identity } = params;

    let model = identity.model;
    if (!model) {
      model = await this.newProductModel(
        task,
        scrapedProduct,
        normalizedSourceName,
      );
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        'new_product',
      );
    }

    this.applyScrapedProductDetails(model, scrapedProduct);

    const sourceRecord = await this.sourceRecordUpdater.upsertSourceRecord({
      model,
      scrapedProduct,
      externalId: scrapedProduct.externalId,
      source: task.source,
      sourceUrl: task.url,
      normalizedSourceName,
    });

    // model.productCategory may only be the { id } stub set by
    // newProductModel/applyScrapedProductDetails — pass the slug explicitly
    // from ScrapedProduct.category, which is always fully populated.
    await this.mergeService.mergeSources(model, scrapedProduct.category.slug);

    const saveOutcome = await this.saveProductModel({ model });
    saveOutcome.sourceRecord ??= sourceRecord;

    if (saveOutcome.created) {
      this.productMetricsService.newProductCreated(task.source.name);
    } else {
      this.productMetricsService.productUpdated(task.source.name);
    }

    task.product = saveOutcome.model;
    if (identity.resolutionContext) {
      task.resolutionContext = identity.resolutionContext;
    }
    await this.taskRepo.save(task);

    return saveOutcome;
  }

  private async applyPostSaveSideEffects(params: {
    task: ScrapeTask;
    scrapedProduct: ScrapedProduct;
    model: ProductModel;
    sourceRecord?: ProductSourceRecord;
  }): Promise<void> {
    const { task, scrapedProduct, model, sourceRecord } = params;

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
      task.source?.id,
    );
    if (insertedCount > 0) {
      this.productMetricsService.productAliasCreated(
        task.source.name,
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
        ? await this.imageCopyService.copyImagesFromSource(model, task.source, [
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
            task.source.name,
            newImages.length,
          );
        }
      }
    }

    await this.createOrUpdateOffers(task, scrapedProduct, model, sourceRecord);
  }

  // No-op for sources whose config doesn't populate ScrapedProduct.offers.
  // Each offer can carry its own `url` (a multi-seller/multi-listing page's
  // itemPipeline can stamp a distinct URL per offer) — a ProductSourceRecord
  // represents one URL, so sourceRecord is resolved per offer here rather
  // than passed as one shared value, falling back to the primary page's own
  // sourceRecord (the ordinary single-offer-per-page case, and the
  // shared-URL multi-seller-table case).
  private async createOrUpdateOffers(
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
    model: ProductModel,
    primarySourceRecord: ProductSourceRecord | undefined,
  ): Promise<void> {
    const offers = scrapedProduct.offers;
    if (isEmpty(offers)) return;

    if (!primarySourceRecord) {
      this.logger.warn(
        'No ProductSourceRecord resolved for this scrape, skipping offer upsert',
        { taskId: task.id, url: task.url },
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
      task.source.id,
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
    for (const scraped of offers!) {
      try {
        const normalizedScrapedUrl = scraped.url
          ? normalizeUrl(scraped.url)
          : undefined;
        const sourceRecord = normalizedScrapedUrl
          ? (model.sources?.find((s) => s.url === normalizedScrapedUrl) ??
            primarySourceRecord)
          : primarySourceRecord;
        touchedSourceRecordIds.add(sourceRecord.id);
        const seller = task.source.seller;
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
          externalId: scraped.externalId,
          locations: scraped.locations,
          specs: scraped.specs ?? pageOfferLevelSpecs,
        });
        upsertedOffers.push(offer);
      } catch (error) {
        // Do not fail the whole product scrape if one offer fails — mirrors
        // the existing brand-resolution-failure tolerance in this service.
        this.logger.warn('Failed to upsert offer, continuing', {
          taskId: task.id,
          url: task.url,
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

  private async findExistingProductModel(
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
    logContext?: Record<string, string>,
  ): Promise<ResolutionResult> {
    const resolution = await this.productSearch.search(
      {
        brand: scrapedProduct.brand,
        model: scrapedProduct.model,
        displayName: scrapedProduct.displayName,
        specs: productSpecsToStructuredSpecs(scrapedProduct.specs),
        category: scrapedProduct.category
          ? {
              id: scrapedProduct.category.id,
              name: scrapedProduct.category.name,
            }
          : undefined,
      },
      {
        useEmbedding: true,
        webSearchEnabled: false,
        mode: 'strict',
        // Let DecisionService fall back to the scrape-merge LLM decision when
        // quality gates reject every candidate but the best one is still
        // close to threshold (see MatchingConfig.llmDecisionFloor) — without
        // this, an ambiguous Path 4 result silently became a new product with
        // no adjudication or review trail. Explicitly NOT webSearchEnabled:
        // true — that would also turn on SERP web search, a different cost/
        // evidence profile this change isn't meant to introduce.
        llmDecisionEnabled: true,
        decisionStrategy: 'scrape-merge',
      },
      undefined,
      logContext,
    );

    if (resolution.resolvedModel?.id) {
      const resolvedModel = await this.productRepo.findOneOrFail({
        where: { id: resolution.resolvedModel.id },
        relations: this.getProductRelations(),
      });
      return {
        resolvedModel,
        context: resolution.context,
        confidence: resolution.confidence,
      };
    }

    return {
      context: resolution.context,
      confidence: resolution.confidence,
    };
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
    task: ScrapeTask,
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
            taskId: task.id,
            url: task.url,
            displayName: scrapedProduct.displayName,
          },
        );
      }
      throw error;
    }
  }
}
