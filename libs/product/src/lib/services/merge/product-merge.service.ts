import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Offer,
  OfferRepository,
  ProductAlias,
  ProductAliasSource,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ScrapeTask,
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
import { ProductIdentityMergeService } from '../product-identity/product-identity-merge.service';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductEmbeddingService } from '../product-embedding.service';
import { ProductDetailService } from '../product-detail.service';

interface MergeProductsParams {
  sourceId: string;
  targetId: string;
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
    private readonly identityMergeService: ProductIdentityMergeService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly detailService: ProductDetailService,
    private readonly offerRepo: OfferRepository,
  ) {}

  /**
   * Denormalizes price/priceWithoutDiscount onto the model from its cheapest
   * active Offer, so product listings can filter/sort by price without
   * joining Offers. Mutates `model` in place; the caller decides
   * whether/when to save. Safe to call whenever a model's offers may have
   * changed (fresh scrape, admin product merge reassigning Offer rows).
   */
  public async recomputePrice(model: ProductModel): Promise<ProductModel> {
    const cheapest = await this.offerRepo.findCheapestActiveOffer(model.id);
    model.price = cheapest?.price;
    model.priceWithoutDiscount = cheapest?.priceWithoutDiscount;
    return model;
  }

  /**
   * The single idempotent "recompute ProductModel from its
   * ProductSourceRecords" operation — specs (via ProductSpecMergeService)
   * and identity fields (via ProductIdentityMergeService) alike. Purely a
   * function of model.sources (already-persisted ProductSourceRecords), so
   * it's safe to call repeatedly, from any trigger (a fresh scrape's
   * source-record upsert, a manual admin retry, or post-model-merge
   * cleanup) with identical results given the same source data — there is
   * no separate "first scrape" vs. "remerge" code path. Mutates `model` in
   * place; the caller decides whether/when to save.
   */
  public async mergeSources(model: ProductModel): Promise<ProductModel> {
    if (isEmpty(model.sources)) {
      return model;
    }

    const categorySlug = model.productCategory?.slug;
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
      model.productCategory!,
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

    await this.identityMergeService.mergeIdentity(model, latestPerSource);

    return model;
  }

  public async mergeProducts(
    params: MergeProductsParams,
  ): Promise<ProductModel> {
    const { sourceId, targetId } = params;

    if (sourceId === targetId) {
      throw new BadRequestException(
        'Source and target product cannot be the same',
      );
    }

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

        await this.moveProductSourceRecords(manager, source, target);
        await this.moveProductImages(manager, source, target);
        await this.moveOffers(manager, sourceId, targetId);
        await this.createAliasesFromSource(manager, source, target);
        await this.moveProductAliases(manager, sourceId, targetId);
        await this.moveScrapeTasks(manager, sourceId, targetId);
        await this.deleteSourceProduct(manager, sourceId);

        this.logger.log('Product merge transaction completed', {
          sourceId,
          targetId,
        });
      },
    );

    await this.postMergeUpdates(targetId);

    return this.detailService.getProductById(targetId);
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

  private async moveProductSourceRecords(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const sourceSources = source.sources ?? [];
    if (isEmpty(sourceSources)) {
      return;
    }

    const targetSourceIds = new Set(
      (target.sources ?? []).map((s) => s.source?.id ?? 'manual'),
    );

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const sourceRecord of sourceSources) {
      if (targetSourceIds.has(sourceRecord.source?.id ?? 'manual')) {
        toDelete.push(sourceRecord.id);
      } else {
        toMove.push(sourceRecord.id);
      }
    }

    if (!isEmpty(toMove)) {
      await manager
        .createQueryBuilder()
        .update(ProductSourceRecord)
        .set({ model: { id: target.id }, deduplicated: true })
        .where('id IN (:...ids)', { ids: toMove })
        .execute();
    }

    if (!isEmpty(toDelete)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(ProductSourceRecord)
        .where('id IN (:...ids)', { ids: toDelete })
        .execute();
    }

    this.logger.debug('Moved product model sources', {
      moved: toMove.length,
      skipped: toDelete.length,
    });
  }

  // Offer.model has onDelete: 'CASCADE' — any Offer still pointing at the
  // source product when deleteSourceProduct runs would be silently destroyed
  // by Postgres's FK cascade (no error, no log line). Must run before that
  // delete. Mirrors moveProductSourceRecords's move-vs-delete-duplicate
  // pattern, using Offer's own unique constraint (seller, sourceListingId)
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
        .filter((o) => o.sourceListingId)
        .map((o) => `${o.seller.id}:${o.sourceListingId}`),
    );

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const offer of sourceOffers) {
      const key = offer.sourceListingId
        ? `${offer.seller.id}:${offer.sourceListingId}`
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

  private async moveScrapeTasks(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(ScrapeTask)
      .set({ product: { id: targetId } })
      .where('"productId" = :sourceId', { sourceId })
      .execute();

    this.logger.debug('Moved scrape tasks', { count: result.affected });
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

      // Recompute specs and identity fields from all sources now that
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
