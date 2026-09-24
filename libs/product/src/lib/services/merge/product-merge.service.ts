import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdvisoryLockService,
  Offer,
  OfferRepository,
  PriceHistory,
  ProductAlias,
  ProductAliasSource,
  ProductDuplicatePairRepository,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductImportTask,
  productLock,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';
import { EntityManager } from 'typeorm';
import { isEmpty } from 'lodash';
import { ProductSpecMergeService } from '../product-spec/product-spec-merge.service';
import { ProductSpecSortService } from '../product-spec/product-spec-sort.service';
import { ProductSpecValidatorService } from '../product-spec/product-spec-validator.service';
import { getLatestSourcePerSource } from '../product-spec/get-latest-source-per-source';
import { getProductLevelSpecs } from '../product-spec/product-level-specs';
import { ProductNameMergeService } from '../product-name/product-name-merge.service';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductEmbeddingService } from '../product-embedding.service';
import { ProductDetailService } from '../product-detail.service';
import { OfferFreshnessService } from '../offer/offer-freshness.service';

interface MergeProductsParams {
  sourceId: string;
  targetId: string;
}

export interface MergeProductsResult {
  product: ProductModel;
  /** Every `ProductSourceRecord` this merge moved onto the target. Splitting
   *  these back out is what reverses the merge — the records carry their own
   *  `scrapedProduct` provenance, so the deleted product can be rebuilt from
   *  live data rather than a snapshot that would go stale. */
  movedSourceRecordIds: string[];
}

const SOURCES_RELATION = nameOf<ProductModel>('sources');
const SOURCES_SOURCE_RELATION = `${SOURCES_RELATION}.${nameOf<ProductSourceRecord>('source')}`;

@Injectable()
export class ProductMergeService {
  private readonly logger = new CustomLogger(ProductMergeService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly specMergeService: ProductSpecMergeService,
    private readonly specSortService: ProductSpecSortService,
    private readonly validatorService: ProductSpecValidatorService,
    private readonly nameMergeService: ProductNameMergeService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly detailService: ProductDetailService,
    private readonly offerRepo: OfferRepository,
    private readonly duplicatePairRepo: ProductDuplicatePairRepository,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly locks: AdvisoryLockService,
  ) {}

  /**
   * Denormalizes price/priceWithoutDiscount onto the model from its cheapest
   * offer that is still within the freshness window (see OfferFreshnessService),
   * so product listings can filter/sort by price without
   * joining Offers. Mutates `model` in place; the caller decides
   * whether/when to save. Safe to call whenever a model's offers may have
   * changed (fresh scrape, admin product merge reassigning Offer rows).
   */
  public async recomputePrice(model: ProductModel): Promise<ProductModel> {
    // Scoped to offers still inside the freshness window. A listing that has
    // gone stale must stop setting the product's headline price immediately,
    // not linger until the sweep deletes it two weeks later — ProductModel.price
    // is what the public listing sorts and filters on.
    //
    // Consequence worth knowing: once every offer on a model ages out, price
    // goes null rather than keeping a knowingly-false value. But recomputePrice
    // only runs on a scrape pass or an admin merge, so a model whose offers all
    // go stale is not recomputed until something touches it — the stale sweep
    // recomputes the models it affects for exactly this reason.
    const cheapest = await this.offerRepo.findCheapestFreshOffer(
      model.id,
      this.offerFreshness.visibleCutoff(),
    );
    // `?? null`, NOT `?? undefined`. TypeORM's save() OMITS undefined-valued
    // properties from the UPDATE, so assigning undefined here left the previous
    // price in the column — this method could raise a price and could never
    // clear one. The comment above claimed the opposite for months, and a model
    // whose offers all aged out (or whose source was deleted) kept advertising
    // a price for offers that no longer existed, in the column the public
    // listing sorts and filters on.
    model.price = cheapest?.price ?? null;
    model.priceWithoutDiscount = cheapest?.priceWithoutDiscount ?? null;
    return model;
  }

  /**
   * The single idempotent "recompute ProductModel from its
   * ProductSourceRecords" operation — specs (via ProductSpecMergeService)
   * and name fields (via ProductNameMergeService) alike. Purely a
   * function of model.sources (already-persisted ProductSourceRecords), so
   * it's safe to call repeatedly, from any trigger (a fresh scrape's
   * source-record upsert, a manual admin retry, or post-model-merge
   * cleanup) with identical results given the same source data — there is
   * no separate "first scrape" vs. "remerge" code path. Mutates `model` in
   * place; the caller decides whether/when to save.
   *
   * `categorySlug` defaults to `model.productCategory?.slug` — pass it
   * explicitly when the caller only has a partially-loaded/stubbed
   * productCategory (e.g. a freshly scraped ProductModel whose
   * productCategory is set to `{ id }` for the FK save) but already knows
   * the real slug from elsewhere (e.g. ScrapedProduct.category.slug).
   */
  public async mergeSources(
    model: ProductModel,
    categorySlug: string | undefined = model.productCategory?.slug,
  ): Promise<ProductModel> {
    if (isEmpty(model.sources)) {
      return model;
    }

    const latestPerSource = getLatestSourcePerSource(model.sources);

    model.specs = await this.specMergeService.mergeSpecs(
      latestPerSource,
      categorySlug,
    );
    model.specs = getProductLevelSpecs(
      this.categoryConfigService,
      model.specs,
      categorySlug,
    );
    model.orderedSpecs = await this.specSortService.sortSpecs(
      categorySlug,
      model.specs,
    );

    const jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;
    const finalValidation = this.validatorService.validateSpecs(
      jsonSchema,
      model.specs,
    );
    model.specValid = finalValidation.isValid;
    model.specErrors = !isEmpty(finalValidation.errors)
      ? finalValidation.errors
      : undefined;

    await this.nameMergeService.mergeNames(
      model,
      latestPerSource,
      categorySlug,
    );

    return model;
  }

  public async mergeProducts(
    params: MergeProductsParams,
  ): Promise<MergeProductsResult> {
    const { sourceId, targetId } = params;

    if (sourceId === targetId) {
      throw new BadRequestException(
        'Source and target product cannot be the same',
      );
    }

    let movedSourceRecordIds: string[] = [];

    // Both products' locks for the whole merge, the recompute included. An
    // import attaching to either one meanwhile would otherwise save a copy
    // loaded before the move over it, and re-bind the moved listings back.
    await this.locks.withLocks(
      [productLock(sourceId), productLock(targetId)],
      async () => {
        movedSourceRecordIds = await this.mergeLocked(sourceId, targetId);
        await this.postMergeUpdates(targetId);
      },
    );

    return {
      product: await this.detailService.getProductById(targetId),
      movedSourceRecordIds,
    };
  }

  private async mergeLocked(sourceId: string, targetId: string): Promise<string[]> {
    let movedSourceRecordIds: string[] = [];

    await this.productRepo.repo.manager.connection.transaction(
      async (manager) => {
        const source = await this.loadProductForMerge(manager, sourceId);
        const target = await this.loadProductForMerge(manager, targetId);

        if (!source) {
          throw new NotFoundException(`Source product ${sourceId} not found`);
        }
        if (!target) {
          throw new NotFoundException(`Target product ${targetId} not found`);
        }

        this.logger.log('Starting product merge', {
          sourceId,
          targetId,
          sourceDisplayName: source.displayName,
          targetDisplayName: target.displayName,
        });

        movedSourceRecordIds = await this.moveProductSourceRecords(
          manager,
          source,
          target,
        );
        await this.moveProductImages(manager, source, target);
        await this.moveOffers(manager, sourceId, targetId);
        await this.createAliasesFromSource(manager, source, target);
        await this.moveProductAliases(manager, sourceId, targetId);
        await this.moveImportTasks(manager, sourceId, targetId);
        await this.movePriceHistory(manager, sourceId, targetId);
        // Before the delete, which cascades the source's own pairs away.
        await this.duplicatePairRepo.carryDismissalsForMerge(
          manager,
          sourceId,
          targetId,
        );
        await this.deleteSourceProduct(manager, sourceId);

        this.logger.log('Product merge transaction completed', {
          sourceId,
          targetId,
          movedSourceRecords: movedSourceRecordIds.length,
        });
      },
    );

    return movedSourceRecordIds;
  }

  private async loadProductForMerge(
    manager: EntityManager,
    productId: string,
  ): Promise<ProductModel | null> {
    return manager.findOne(ProductModel, {
      where: { id: productId },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('aliases'),
        nameOf<ProductModel>('sources'),
        nameOf<ProductModel>('images'),
      ],
    });
  }

  /**
   * Moves EVERY source record to the target — none are dropped.
   *
   * There is no unique constraint on (model, source); the unique is
   * (source, url). A source legitimately accumulates several records on one
   * product (one per variant URL — see ProductScrapeUpdaterService's Path 4),
   * so two records from the same source are two different listings, not a
   * duplicate. Deleting one would destroy a real listing along with its
   * `scrapedProduct` provenance.
   *
   * Note this merge can legitimately put two records with the SAME url on one
   * model, when they come from different sources covering the same webshop
   * (a page scraper and an Árukereső feed). That is not a duplicate either:
   * each holds its own source's view of the listing.
   *
   * Keeping them all is also what makes a merge reversible: the returned ids are
   * the complete set to split back out, and `mergeSources` reduces per-source
   * via getLatestSourcePerSource anyway, so spec merging is unaffected.
   */
  private async moveProductSourceRecords(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<string[]> {
    const sourceSources = source.sources ?? [];
    if (isEmpty(sourceSources)) {
      return [];
    }

    const movedIds = sourceSources.map((sourceRecord) => sourceRecord.id);

    await manager
      .createQueryBuilder()
      .update(ProductSourceRecord)
      .set({ model: { id: target.id } })
      .where('id IN (:...ids)', { ids: movedIds })
      .execute();

    this.logger.debug('Moved product model sources', {
      moved: movedIds.length,
    });

    return movedIds;
  }

  // PriceHistory.model is onDelete: 'CASCADE', so any row still pointing at the
  // source product when deleteSourceProduct runs is silently destroyed by
  // Postgres. Reassign first, same requirement as moveOffers. No collision
  // handling needed: price history is an append-only observation log with no
  // uniqueness constraint, so the two products' histories simply coexist.
  private async movePriceHistory(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(PriceHistory)
      .set({ model: { id: targetId } })
      .where('"modelId" = :sourceId', { sourceId })
      .execute();

    this.logger.debug('Moved price history', { count: result.affected });
  }

  // Offer.model has onDelete: 'CASCADE' — any Offer still pointing at the
  // source product when deleteSourceProduct runs would be silently destroyed
  // by Postgres's FK cascade (no error, no log line). Must run before that
  // delete. Mirrors moveProductSourceRecords's move-vs-delete-duplicate
  // pattern, using Offer's own unique constraint (seller, externalId)
  // to decide which source-side offers collide with an existing target-side
  // offer (same seller already selling this exact listing) versus which are
  // safe to reassign outright.
  private async moveOffers(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const sourceOffers = await manager.find(Offer, {
      where: { model: { id: sourceId } },
      relations: [nameOf<Offer>('seller')],
    });

    if (isEmpty(sourceOffers)) {
      return;
    }

    const targetOffers = await manager.find(Offer, {
      where: { model: { id: targetId } },
      relations: [nameOf<Offer>('seller')],
    });
    const targetOfferKeys = new Set(
      targetOffers
        .filter((o) => o.externalId)
        .map((o) => `${o.seller.id}:${o.externalId}`),
    );

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const offer of sourceOffers) {
      const key = offer.externalId
        ? `${offer.seller.id}:${offer.externalId}`
        : undefined;
      if (key && targetOfferKeys.has(key)) {
        toDelete.push(offer.id);
      } else {
        toMove.push(offer.id);
      }
    }

    if (!isEmpty(toMove)) {
      await manager
        .createQueryBuilder()
        .update(Offer)
        .set({ model: { id: targetId } })
        .where('id IN (:...ids)', { ids: toMove })
        .execute();
    }

    if (!isEmpty(toDelete)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(Offer)
        .where('id IN (:...ids)', { ids: toDelete })
        .execute();
    }

    this.logger.debug('Moved product offers', {
      moved: toMove.length,
      skipped: toDelete.length,
    });
  }

  private async moveProductImages(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const sourceImages = source.images ?? [];
    if (isEmpty(sourceImages)) {
      return;
    }

    // Clear source's mainImage FK to avoid constraint issues
    await manager
      .createQueryBuilder()
      .update(ProductModel)
      .set({ mainImage: null })
      .where('id = :id', { id: source.id })
      .execute();

    const targetImages = target.images ?? [];
    const maxOrder = isEmpty(targetImages)
      ? 0
      : Math.max(...targetImages.map((img) => img.order)) + 1;

    // Update each source image: move to target and offset order
    for (let i = 0; i < sourceImages.length; i++) {
      await manager
        .createQueryBuilder()
        .update(ProductImage)
        .set({
          model: { id: target.id },
          order: maxOrder + i,
        })
        .where('id = :id', { id: sourceImages[i].id })
        .execute();
    }

    this.logger.debug('Moved product images', {
      count: sourceImages.length,
      startingOrder: maxOrder,
    });
  }

  private async createAliasesFromSource(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const namesToAlias = [
      source.displayName,
      source.normalizedName,
      source.model,
    ];
    const uniqueNames = [...new Set(namesToAlias)].filter(
      (name) =>
        name && name !== target.displayName && name !== target.normalizedName,
    );

    for (const name of uniqueNames) {
      await this.tryCreateAlias(manager, name, target.id);
    }
  }

  private async tryCreateAlias(
    manager: EntityManager,
    alias: string,
    targetId: string,
  ): Promise<void> {
    try {
      const existing = await manager.findOne(ProductAlias, {
        where: { alias },
      });
      if (existing) {
        return;
      }

      const newAlias = new ProductAlias();
      newAlias.alias = alias;
      newAlias.source = ProductAliasSource.manual;
      newAlias.model = { id: targetId } as ProductModel;
      await manager.save(newAlias);
    } catch (error: unknown) {
      // Unique constraint violation — alias already exists, skip
      this.logger.debug('Skipped duplicate alias', { alias, targetId });
    }
  }

  private async moveProductAliases(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    // Find remaining source aliases (some may have been deleted by CASCADE or already exist on target)
    const sourceAliases = await manager.find(ProductAlias, {
      where: { model: { id: sourceId } },
    });

    if (isEmpty(sourceAliases)) {
      return;
    }

    // Check which alias texts already exist on the target
    const existingTargetAliases = await manager.find(ProductAlias, {
      where: { model: { id: targetId } },
    });
    const existingAliasTexts = new Set(
      existingTargetAliases.map((a) => a.alias),
    );

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const alias of sourceAliases) {
      if (existingAliasTexts.has(alias.alias)) {
        toDelete.push(alias.id);
      } else {
        toMove.push(alias.id);
      }
    }

    if (!isEmpty(toDelete)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(ProductAlias)
        .where('id IN (:...ids)', { ids: toDelete })
        .execute();
    }

    if (!isEmpty(toMove)) {
      await manager
        .createQueryBuilder()
        .update(ProductAlias)
        .set({ model: { id: targetId } })
        .where('id IN (:...ids)', { ids: toMove })
        .execute();
    }

    this.logger.debug('Moved product aliases', {
      moved: toMove.length,
      skipped: toDelete.length,
    });
  }

  private async moveImportTasks(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(ProductImportTask)
      .set({ product: { id: targetId } })
      .where('"productId" = :sourceId', { sourceId })
      .execute();

    this.logger.debug('Moved import tasks', { count: result.affected });
  }

  private async deleteSourceProduct(
    manager: EntityManager,
    sourceId: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .delete()
      .from(ProductModel)
      .where('id = :id', { id: sourceId })
      .execute();

    this.logger.log('Deleted source product', { sourceId });
  }

  private async postMergeUpdates(targetId: string): Promise<void> {
    try {
      // Reload target with all relations needed for post-merge updates
      const target = await this.productRepo.findOneOrFail({
        where: { id: targetId },
        relations: [
          nameOf<ProductModel>('brand'),
          nameOf<ProductModel>('productCategory'),
          SOURCES_RELATION,
          SOURCES_SOURCE_RELATION,
        ],
      });

      // Recompute specs and name fields from all sources now that
      // sources have been consolidated
      if (!isEmpty(target.sources)) {
        await this.mergeSources(target);
        await this.productRepo.save(target);
      }

      // Recompute price/priceWithoutDiscount now that moveOffers has
      // reassigned the source product's Offer rows onto this target
      await this.recomputePrice(target);
      await this.productRepo.save(target);

      // Regenerate embedding
      const embedding = await this.embeddingService.createProductEmbedding({
        brand: target.brand?.name,
        model: target.model,
        displayName: target.displayName,
        category: target.productCategory?.name,
      });

      if (target.embedding) {
        target.embedding.embedding = embedding;
      }
      await this.productRepo.save(target);

      this.logger.log('Post-merge updates completed', { targetId });
    } catch (error: unknown) {
      this.logger.warn('Post-merge updates failed (merge itself succeeded)', {
        targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
