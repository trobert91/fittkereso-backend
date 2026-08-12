import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ProductAlias,
  ProductAliasSource,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductModelSource,
  ScrapeTask,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';
import { EntityManager } from 'typeorm';
import { isEmpty } from 'lodash';
import { ProductSpecUpdaterService } from '../product-spec/product-spec-updater.service';
import { ProductEmbeddingService } from '../product-embedding.service';
import { ProductDetailService } from '../product-detail.service';

interface MergeProductsParams {
  sourceId: string;
  targetId: string;
}

@Injectable()
export class ProductMergeService {
  private readonly logger = new CustomLogger(ProductMergeService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly specUpdater: ProductSpecUpdaterService,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly detailService: ProductDetailService,
  ) {}

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

        await this.moveProductModelSources(manager, source, target);
        await this.moveProductImages(manager, source, target);
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

  private async moveProductModelSources(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const sourceSources = source.sources ?? [];
    if (isEmpty(sourceSources)) {
      return;
    }

    const targetTypes = new Set((target.sources ?? []).map((s) => s.type));

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const sourceRecord of sourceSources) {
      if (targetTypes.has(sourceRecord.type)) {
        toDelete.push(sourceRecord.id);
      } else {
        toMove.push(sourceRecord.id);
      }
    }

    if (!isEmpty(toMove)) {
      await manager
        .createQueryBuilder()
        .update(ProductModelSource)
        .set({ model: { id: target.id }, deduplicated: true })
        .where('id IN (:...ids)', { ids: toMove })
        .execute();
    }

    if (!isEmpty(toDelete)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(ProductModelSource)
        .where('id IN (:...ids)', { ids: toDelete })
        .execute();
    }

    this.logger.debug('Moved product model sources', {
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
          nameOf<ProductModel>('sources'),
        ],
      });

      // Re-merge specs from all sources now that sources have been consolidated
      if (!isEmpty(target.sources)) {
        await this.specUpdater.remergeSpecsFromSources(target);
        await this.productRepo.save(target);
      }

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
