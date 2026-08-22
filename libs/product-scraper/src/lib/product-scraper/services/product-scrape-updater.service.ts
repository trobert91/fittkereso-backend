import { Injectable } from '@nestjs/common';
import {
  OfferRepository,
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductCategory,
  ProductEmbedding,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapeTask,
  ScrapeTaskRepository,
} from '@fittkereso-backend/database';
import {
  ResolutionContext,
  ResolutionResult,
  ResolutionService,
  productSpecsToStructuredSpecs,
} from '@fittkereso-backend/resolution';
import { generateSlug, nameOf, normalize } from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  BrandResolutionService,
  ProductEmbeddingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductNormalizerService,
  ProductSourceRecordUpdaterService,
  SellerResolutionService,
} from '@fittkereso-backend/product';
import { ScrapedProduct } from '@fittkereso-backend/product';
import { isEmpty, minBy, pick } from 'lodash';
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
  private readonly normalizedNameConstraint =
    'UQ_product_brand_normalized_name';

  constructor(
    private readonly productSearch: ResolutionService,
    private readonly brandResolution: BrandResolutionService,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly productRepo: ProductModelRepository,
    private readonly taskRepo: ScrapeTaskRepository,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly sourceRecordUpdater: ProductSourceRecordUpdaterService,
    private readonly mergeService: ProductMergeService,
    private readonly imageCopyService: ProductImageCopyService,
    private readonly productMetricsService: ProductMetricsService,
    private readonly productNormalizer: ProductNormalizerService,
    private readonly sellerResolution: SellerResolutionService,
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
      const identity = await this.resolveProductIdentity(
        task,
        scrapedProduct,
        normalizedSourceName,
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

  // One canonical name for this scrape, used for Path 1 lookup, for the new
  // ProductSourceRecord row, and for ProductModel.normalizedName on new products.
  private buildNormalizedSourceName(scrapedProduct: ScrapedProduct): string {
    const strategy =
      this.categoryConfigService.getConfig(scrapedProduct.category?.slug)
        ?.normalizationStrategy ?? 'digit-heuristic';
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
    normalizedSourceName: string,
  ): Promise<ResolvedIdentity> {
    // Path 0: task already pinned to a product
    if (task.product?.id) {
      const model = await this.productRepo.findOneOrFail({
        where: { id: task.product.id },
        relations: this.getProductRelations(),
      });
      return { model, isExistingMatch: true };
    }

    // Path 0.5: this exact (source, externalId) listing was already scraped
    // and linked to a product — reuse that link directly rather than
    // re-deriving identity from the name or falling through to the
    // matcher/embedding/LLM pipeline in Path 2. externalId is the
    // source-native SKU/model code/slug and is stable across URL and
    // display-name changes, unlike Path 1's normalizedSourceName.
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

    // Path 1: name-anchored identity lookup (any source, same category).
    // Category presence is guaranteed by the caller's pre-check.
    const categoryId = scrapedProduct.category?.id;
    if (!categoryId) {
      return { isExistingMatch: false };
    }
    const sourceRows =
      await this.sourceRecordRepo.findAllByNormalizedName(
        normalizedSourceName,
        categoryId,
      );
    const path1Match = this.selectPath1Match(sourceRows, task, scrapedProduct);
    if (path1Match) {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        'path1_hit',
      );
      return { model: path1Match.model, isExistingMatch: true };
    }

    // Path 2: strict cross-source search.
    // Agent already filters candidates to category C via preResolvedCategories.
    const resolved = await this.findExistingProductModel(scrapedProduct, {
      taskId: task.id,
    });
    const candidate = resolved.resolvedModel;
    const resolutionContext = resolved.context;

    if (candidate && this.hasSourceRow(candidate, task.source.id)) {
      // The same source already has a different name pointing at this product —
      // this scrape is a distinct product by the source catalog's own definition.
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        'cross_source_rejected_same_source',
      );
      this.logger.debug(
        'Path 2 candidate rejected — source already has a row on this product',
        {
          taskId: task.id,
          url: task.url,
          candidateId: candidate.id,
          sourceName: task.source.name,
          normalizedSourceName,
        },
      );
      return { isExistingMatch: false, resolutionContext };
    }

    if (candidate) {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.name,
        'cross_source_merge',
      );
      this.productMetricsService.productMatched(task.source.name);
      return { model: candidate, isExistingMatch: true, resolutionContext };
    }

    return { isExistingMatch: false, resolutionContext };
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

    const saveOutcome = await this.saveProductModel({
      model,
      normalizedSourceName,
      scrapedProduct,
      task,
    });
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

    const newImages = await this.imageCopyService.copyImagesFromSource(
      model,
      task.source,
      scrapedProduct.imageUrls ?? [],
    );
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

    await this.createOrUpdateOffers(task, scrapedProduct, model, sourceRecord);
  }

  // No-op for sources whose config doesn't populate ScrapedProduct.offers.
  private async createOrUpdateOffers(
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
    model: ProductModel,
    sourceRecord: ProductSourceRecord | undefined,
  ): Promise<void> {
    const offers = scrapedProduct.offers;
    if (isEmpty(offers)) return;

    if (!sourceRecord) {
      this.logger.warn(
        'No ProductSourceRecord resolved for this scrape, skipping offer upsert',
        { taskId: task.id, url: task.url },
      );
      return;
    }

    // Page-level offer-level specs (e.g. frameSize, color), derived from this
    // listing's own spec set. Applied to every offer on the page by default;
    // an individual ScrapedOffer.specs overrides this for sources that report
    // multiple size/color variants on a single product page. Always optional
    // — a listing with no extractable offer-level values simply yields {}.
    const offerLevelKeys =
      this.categoryConfigService.getConfig(scrapedProduct.category?.slug)
        ?.offerLevelSpecs ?? [];
    const pageOfferLevelSpecs = pick(
      sourceRecord.scrapedProduct?.specs,
      offerLevelKeys,
    );

    let upsertedAny = false;
    for (const scraped of offers!) {
      try {
        const seller = await this.sellerResolution.resolveOrCreate(
          scraped.sellerName,
        );
        await this.offerRepo.upsertFromScrape({
          model,
          seller,
          sourceRecord,
          price: scraped.price,
          priceWithoutDiscount: scraped.priceWithoutDiscount,
          currency: scraped.currency,
          availability: scraped.availability,
          url: scraped.url,
          sourceListingId: scraped.sourceListingId,
          specs: scraped.specs ?? pageOfferLevelSpecs,
        });
        upsertedAny = true;
      } catch (error) {
        // Do not fail the whole product scrape if one offer fails — mirrors
        // the existing brand-resolution-failure tolerance in this service.
        this.logger.warn('Failed to upsert offer, continuing', {
          taskId: task.id,
          url: task.url,
          sellerName: scraped.sellerName,
          error,
        });
      }
    }

    if (upsertedAny) {
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

  private hasSourceRow(model: ProductModel, sourceId: string): boolean {
    return (
      model.sources?.some((source) => source.source?.id === sourceId) ?? false
    );
  }

  // Pick the right Path 1 hit when multiple source rows share a normalizedSourceName
  // (e.g. color/variant siblings like "39GS95QE-B" and "39GS95QE-W" both normalize
  // to "39gs95qe"). Prefer an exact name match from the same source; accept any
  // cross-source row; reject same-source-different-name rows so Path 2's same-source
  // gate can treat the scrape as a distinct product.
  private selectPath1Match(
    sourceRows: ProductSourceRecord[],
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
  ): ProductSourceRecord | undefined {
    if (isEmpty(sourceRows)) return undefined;

    const incomingName = scrapedProduct.displayName?.toLowerCase();
    const exactMatch = sourceRows.find(
      (row) =>
        row.source?.id === task.source.id &&
        row.scrapedProduct?.displayName?.toLowerCase() === incomingName,
    );
    if (exactMatch) return exactMatch;

    return sourceRows.find((row) => row.source?.id !== task.source.id);
  }

  private async findExistingProductModel(
    scrapedProduct: ScrapedProduct,
    logContext?: Record<string, string>,
  ): Promise<ResolutionResult> {
    const resolution = await this.productSearch.search(
      {
        brand: scrapedProduct.brand,
        model: scrapedProduct.model,
        displayName: scrapedProduct.displayName,
        specs: productSpecsToStructuredSpecs(scrapedProduct.specs),
        releaseYear: scrapedProduct.releaseYear,
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

    return { context: resolution.context, confidence: resolution.confidence };
  }

  private async findExistingProductModelByNormalizedName(
    normalizedName: string,
    brandId: string,
  ): Promise<ProductModel | undefined> {
    return (
      (await this.productRepo.findOne({
        where: { normalizedName, brand: { id: brandId } },
        relations: this.getProductRelations(),
      })) ?? undefined
    );
  }

  private async saveProductModel(params: {
    model: ProductModel;
    normalizedSourceName: string;
    scrapedProduct: ScrapedProduct;
    task: ScrapeTask;
  }): Promise<PersistResult> {
    const { model, normalizedSourceName, scrapedProduct, task } = params;
    const isNewModel = !model.id;

    try {
      return {
        model: await this.productRepo.save(model),
        created: isNewModel,
      };
    } catch (error) {
      if (!isNewModel || !this.isNormalizedNameConflict(error)) {
        throw error;
      }

      const existingModel = await this.findExistingProductModelByNormalizedName(
        normalizedSourceName,
        model.brand.id,
      );
      if (!existingModel) {
        throw error;
      }

      this.logger.debug(
        'Reusing product created by concurrent worker after normalizedName conflict',
        {
          taskId: task.id,
          productId: existingModel.id,
          normalizedSourceName,
          url: task.url,
        },
      );

      this.applyScrapedProductDetails(existingModel, scrapedProduct);
      const sourceRecord = await this.sourceRecordUpdater.upsertSourceRecord({
        model: existingModel,
        scrapedProduct,
        externalId: scrapedProduct.externalId,
        source: task.source,
        sourceUrl: task.url,
        normalizedSourceName,
      });
      await this.mergeService.mergeSources(existingModel, scrapedProduct.category.slug);

      return {
        model: await this.productRepo.save(existingModel),
        created: false,
        sourceRecord,
      };
    }
  }

  private applyScrapedProductDetails(
    model: ProductModel,
    scrapedProduct: ScrapedProduct,
  ): void {
    if (!model.releaseYear && scrapedProduct.releaseYear) {
      model.releaseYear = scrapedProduct.releaseYear;
    }

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

  private isNormalizedNameConflict(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes('duplicate key value') &&
      error.message.includes(this.normalizedNameConstraint)
    );
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
    const brand = await this.brandResolution.resolve(
      scrapedProduct.brand,
      scrapedProduct.displayName,
    );

    if (!brand?.entity) {
      this.logger.warn(
        'Brand could not be identified, skipping product creation',
        {
          taskId: task.id,
          url: task.url,
          displayName: scrapedProduct.displayName,
        },
      );

      throw new Error('Brand could not be identified');
    }

    const model = new ProductModel();
    model.productCategory = { id: scrapedProduct.category.id } as ProductCategory;

    model.brand = brand.entity;
    model.displayName = scrapedProduct.displayName;
    model.model = scrapedProduct.model;
    model.normalizedName = normalizedSourceName;
    model.enabled = true;

    model.embedding = new ProductEmbedding();
    model.embedding.embedding =
      await this.embeddingService.createProductEmbedding({
        brand: model.brand.name,
        model: model.model,
        displayName: model.displayName,
        category: scrapedProduct.category.name,
      });

    return model;
  }
}
