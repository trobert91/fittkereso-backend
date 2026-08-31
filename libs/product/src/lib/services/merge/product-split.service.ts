import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Offer,
  PriceHistory,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapeTask,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';
import { EntityManager } from 'typeorm';
import { compact, isEmpty, uniq } from 'lodash';
import { ProductMergeService } from './product-merge.service';
import { ProductModelFactoryService } from '../product-model-factory.service';
import { ProductEmbeddingService } from '../product-embedding.service';

export interface SplitIntoNewProductParams {
  /** The listings to carve out. All must currently belong to the same product. */
  sourceRecordIds: string[];
  /** Free-text explanation for the log line (e.g. which resolution triggered it). */
  reason: string;
}

/**
 * Carves a set of `ProductSourceRecord`s out of the product they currently sit
 * on and into a brand-new product — the inverse of a merge, and the single
 * corrective primitive behind both review actions that need one.
 *
 * Splitting one listing (a resolution matched the wrong existing product) and
 * reversing a merge (all the listings that merge moved) differ only in how many
 * records are named, so both go through this one method. Nothing is restored
 * from a snapshot: the new product's specs and identity are recomputed from the
 * records' own `scrapedProduct` data via `mergeSources`, so the result reflects
 * the latest scrape rather than a frozen copy taken at merge time.
 */
@Injectable()
export class ProductSplitService {
  private readonly logger = new CustomLogger(ProductSplitService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly mergeService: ProductMergeService,
    private readonly modelFactory: ProductModelFactoryService,
    private readonly embeddingService: ProductEmbeddingService,
  ) {}

  public async splitIntoNewProduct(
    params: SplitIntoNewProductParams,
  ): Promise<ProductModel> {
    const { sourceRecordIds, reason } = params;

    if (isEmpty(sourceRecordIds)) {
      throw new BadRequestException('No source records given to split');
    }

    const records = await this.loadRecords(sourceRecordIds);
    const originId = this.assertSingleOrigin(records);
    const newModel = await this.buildNewModel(records);

    await this.productRepo.repo.manager.connection.transaction(
      async (manager) => {
        const saved = await manager.save(newModel);
        newModel.id = saved.id;

        await this.moveSourceRecords(manager, sourceRecordIds, saved.id);
        await this.moveOffers(manager, sourceRecordIds, saved.id);
        await this.moveScrapeTasks(manager, records, originId, saved.id);
        await this.movePriceHistory(manager, sourceRecordIds, saved.id);

        this.logger.log('Product split transaction completed', {
          reason,
          originId,
          newProductId: saved.id,
          sourceRecords: sourceRecordIds.length,
        });
      },
    );

    // Both products changed shape — the new one gained every source it has, the
    // old one lost some. Best-effort like postMergeUpdates: the structural move
    // already succeeded and is what matters.
    await this.recomputeProduct(newModel.id);
    await this.recomputeProduct(originId);

    return this.productRepo.findOneOrFail({ where: { id: newModel.id } });
  }

  private async loadRecords(ids: string[]): Promise<ProductSourceRecord[]> {
    const records = await this.sourceRecordRepo.find({
      where: ids.map((id) => ({ id })),
      relations: [
        nameOf<ProductSourceRecord>('model'),
        `${nameOf<ProductSourceRecord>('model')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductSourceRecord>('model')}.${nameOf<ProductModel>('productCategory')}`,
        nameOf<ProductSourceRecord>('source'),
      ],
    });

    if (records.length !== ids.length) {
      const found = new Set(records.map((record) => record.id));
      throw new NotFoundException(
        `Source records not found: ${ids.filter((id) => !found.has(id)).join(', ')}`,
      );
    }

    return records;
  }

  /** A split produces exactly one new product, so the records must start out on
   *  one product — otherwise the caller is asking for something ambiguous. */
  private assertSingleOrigin(records: ProductSourceRecord[]): string {
    const originIds = uniq(compact(records.map((record) => record.model?.id)));

    if (originIds.length !== 1) {
      throw new BadRequestException(
        `Source records must all belong to one product, found ${originIds.length}`,
      );
    }

    return originIds[0];
  }

  private async buildNewModel(
    records: ProductSourceRecord[],
  ): Promise<ProductModel> {
    // The newest record describes the listing best — later scrapes supersede
    // earlier ones for identity purposes, same ordering mergeSources uses.
    const newest = [...records].sort(
      (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime(),
    )[0];
    const scraped = newest.scrapedProduct;
    const categoryId = scraped?.category?.id ?? newest.model?.productCategory?.id;

    if (!categoryId) {
      throw new BadRequestException(
        'Cannot split: no category on the source record or its product',
      );
    }

    // A manual/admin-entered record carries only specs, so fall back through
    // the record's own identity fields before the product it is leaving.
    const displayName =
      scraped?.displayName ?? newest.normalizedSourceName ?? newest.model?.displayName;
    if (!displayName) {
      throw new BadRequestException(
        'Cannot split: source record has no name to build a product from',
      );
    }

    return this.modelFactory.createShell({
      brandName: scraped?.brand ?? newest.model?.brand?.name,
      displayName,
      model: scraped?.model ?? newest.model?.model ?? displayName,
      categoryId,
      categoryName: scraped?.category?.name,
      normalizedName: newest.normalizedSourceName ?? displayName,
    });
  }

  private async moveSourceRecords(
    manager: EntityManager,
    ids: string[],
    newModelId: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(ProductSourceRecord)
      .set({ model: { id: newModelId } })
      .where('id IN (:...ids)', { ids })
      .execute();
  }

  // Offers carry both a model and a sourceRecord FK; only the model moves, so
  // scoping by sourceRecord is what keeps the split to exactly these listings.
  private async moveOffers(
    manager: EntityManager,
    sourceRecordIds: string[],
    newModelId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(Offer)
      .set({ model: { id: newModelId } })
      .where('"sourceRecordId" IN (:...sourceRecordIds)', { sourceRecordIds })
      .execute();

    this.logger.debug('Moved offers to split product', {
      count: result.affected,
    });
  }

  // ScrapeTask has no sourceRecord FK, so correlate by URL — the same identity
  // the scraper itself uses to recognize an already-known listing.
  private async moveScrapeTasks(
    manager: EntityManager,
    records: ProductSourceRecord[],
    originId: string,
    newModelId: string,
  ): Promise<void> {
    const urls = compact(records.map((record) => record.url));
    if (isEmpty(urls)) {
      return;
    }

    const result = await manager
      .createQueryBuilder()
      .update(ScrapeTask)
      .set({ product: { id: newModelId } })
      .where('"productId" = :originId', { originId })
      .andWhere('url IN (:...urls)', { urls })
      .execute();

    this.logger.debug('Moved scrape tasks to split product', {
      count: result.affected,
    });
  }

  // Price history belongs to an offer; the rows whose offer just moved should
  // follow it, so the new product keeps its own price trail.
  private async movePriceHistory(
    manager: EntityManager,
    sourceRecordIds: string[],
    newModelId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(PriceHistory)
      .set({ model: { id: newModelId } })
      .where(
        `"offerId" IN (SELECT id FROM offer WHERE "sourceRecordId" IN (:...sourceRecordIds))`,
        { sourceRecordIds },
      )
      .execute();

    this.logger.debug('Moved price history to split product', {
      count: result.affected,
    });
  }

  /** Recompute specs/identity/price/embedding from whatever sources a product
   *  has now. Non-fatal: the structural move is already committed. */
  private async recomputeProduct(productId: string): Promise<void> {
    try {
      const product = await this.productRepo.findOne({
        where: { id: productId },
        relations: [
          nameOf<ProductModel>('brand'),
          nameOf<ProductModel>('productCategory'),
          nameOf<ProductModel>('sources'),
          `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
        ],
      });

      if (!product) {
        return;
      }

      if (!isEmpty(product.sources)) {
        await this.mergeService.mergeSources(product);
      }
      await this.mergeService.recomputePrice(product);

      const embedding = await this.embeddingService.createProductEmbedding({
        brand: product.brand?.name,
        model: product.model,
        displayName: product.displayName,
        category: product.productCategory?.name,
      });
      if (product.embedding) {
        product.embedding.embedding = embedding;
      }

      await this.productRepo.save(product);
    } catch (error: unknown) {
      this.logger.warn('Post-split recompute failed (split itself succeeded)', {
        productId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
