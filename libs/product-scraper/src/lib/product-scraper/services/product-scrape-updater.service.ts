import { Injectable } from "@nestjs/common";
import {
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductEmbedding,
  ProductModel,
  ProductModelRepository,
  ProductModelSource,
  ProductModelSourceRepository,
  ScrapeTask,
  ScrapeTaskRepository,
} from "@ebike-backend/database";
import {
  ResolutionContext,
  ResolutionResult,
  ResolutionService,
  productSpecsToStructuredSpecs,
} from "@ebike-backend/resolution";
import { generateSlug, nameOf, normalize } from "@ebike-backend/utils";
import { CustomLogger } from "@ebike-backend/logger";
import {
  BrandResolutionService,
  ProductEmbeddingService,
  ProductImageCopyService,
  ProductNormalizerService,
  ProductSpecUpdaterService,
} from "@ebike-backend/product";
import { ScrapedProduct } from "@ebike-backend/product";
import { isEmpty, minBy } from "lodash";
import { ProductMetricsService } from "@ebike-backend/metrics";

interface ResolvedIdentity {
  model?: ProductModel;
  isExistingMatch: boolean;
  resolutionContext?: ResolutionContext;
}

interface PersistResult {
  model: ProductModel;
  created: boolean;
}

@Injectable()
export class ProductScrapeUpdaterService {
  private readonly logger = new CustomLogger(ProductScrapeUpdaterService.name);
  private readonly normalizedNameConstraint =
    "UQ_product_brand_normalized_name";

  constructor(
    private readonly productSearch: ResolutionService,
    private readonly brandResolution: BrandResolutionService,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly productRepo: ProductModelRepository,
    private readonly taskRepo: ScrapeTaskRepository,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly productModelSourceRepo: ProductModelSourceRepository,
    private readonly specUpdaterService: ProductSpecUpdaterService,
    private readonly imageCopyService: ProductImageCopyService,
    private readonly productMetricsService: ProductMetricsService,
    private readonly productNormalizer: ProductNormalizerService,
  ) {}

  public async createOrUpdateProduct(
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
  ): Promise<ProductModel | undefined> {
    if (!scrapedProduct.category?.id) {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.type,
        "skipped_no_category",
      );
      this.logger.warn("Skipping scrape — no category identified", {
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
      });
      return persisted.model;
    } catch (error) {
      // do not fail the whole scraping if brand resolution fails
      if ((error as Error).message?.includes("Brand could not be identified")) {
        this.productMetricsService.productBrandResolutionFailed(
          task.source.type,
        );
        return undefined;
      }
      throw error;
    }
  }

  // One canonical name for this scrape, used for Path 1 lookup, for the new
  // ProductModelSource row, and for ProductModel.normalizedName on new products.
  private buildNormalizedSourceName(scrapedProduct: ScrapedProduct): string {
    return this.productNormalizer.normalizeProduct({
      brand: scrapedProduct.brand,
      model: scrapedProduct.model,
      displayName: scrapedProduct.displayName,
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

    // Path 1: name-anchored identity lookup (any source, same category).
    // Category presence is guaranteed by the caller's pre-check.
    const categoryId = scrapedProduct.category?.id;
    if (!categoryId) {
      return { isExistingMatch: false };
    }
    const sourceRows =
      await this.productModelSourceRepo.findAllByNormalizedName(
        normalizedSourceName,
        categoryId,
      );
    const path1Match = this.selectPath1Match(sourceRows, task, scrapedProduct);
    if (path1Match) {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.type,
        "path1_hit",
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

    if (candidate && this.hasSourceOfType(candidate, task.source.type)) {
      // The same source already has a different name pointing at this product —
      // this scrape is a distinct product by the source catalog's own definition.
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.type,
        "cross_source_rejected_same_source",
      );
      this.logger.debug(
        "Path 2 candidate rejected — source already has a row on this product",
        {
          taskId: task.id,
          url: task.url,
          candidateId: candidate.id,
          sourceType: task.source.type,
          normalizedSourceName,
        },
      );
      return { isExistingMatch: false, resolutionContext };
    }

    if (candidate) {
      this.productMetricsService.scrapeResolutionOutcome(
        task.source.type,
        "cross_source_merge",
      );
      this.productMetricsService.productMatched(task.source.type);
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
        task.source.type,
        "new_product",
      );
    }

    this.applyScrapedProductDetails(model, scrapedProduct);

    await this.specUpdaterService.updateSpecsOnProduct({
      model,
      specs: scrapedProduct.specs,
      sourceType: task.source.type,
      sourceUrl: task.url,
      sourceName: scrapedProduct.displayName,
      normalizedSourceName,
    });

    const saveOutcome = await this.saveProductModel({
      model,
      normalizedSourceName,
      scrapedProduct,
      task,
    });

    if (saveOutcome.created) {
      this.productMetricsService.newProductCreated(task.source.type);
    } else {
      this.productMetricsService.productUpdated(task.source.type);
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
  }): Promise<void> {
    const { task, scrapedProduct, model } = params;

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
        task.source.type,
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
          task.source.type,
          newImages.length,
        );
      }
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
      .returning("id")
      .execute();

    return result.generatedMaps.length || result.identifiers.length;
  }

  private hasSourceOfType(model: ProductModel, sourceType: string): boolean {
    return model.sources?.some((source) => source.type === sourceType) ?? false;
  }

  // Pick the right Path 1 hit when multiple source rows share a normalizedSourceName
  // (e.g. color/variant siblings like "39GS95QE-B" and "39GS95QE-W" both normalize
  // to "39gs95qe"). Prefer an exact name match from the same source; accept any
  // cross-source row; reject same-source-different-name rows so Path 2's same-source
  // gate can treat the scrape as a distinct product.
  private selectPath1Match(
    sourceRows: ProductModelSource[],
    task: ScrapeTask,
    scrapedProduct: ScrapedProduct,
  ): ProductModelSource | undefined {
    if (isEmpty(sourceRows)) return undefined;

    const incomingName = scrapedProduct.displayName?.toLowerCase();
    const exactMatch = sourceRows.find(
      (row) =>
        row.type === task.source.type &&
        row.sourceName?.toLowerCase() === incomingName,
    );
    if (exactMatch) return exactMatch;

    return sourceRows.find((row) => row.type !== task.source.type);
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
        mode: "strict",
      },
      {},
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
        "Reusing product created by concurrent worker after normalizedName conflict",
        {
          taskId: task.id,
          productId: existingModel.id,
          normalizedSourceName,
          url: task.url,
        },
      );

      this.applyScrapedProductDetails(existingModel, scrapedProduct);
      await this.specUpdaterService.updateSpecsOnProduct({
        model: existingModel,
        specs: scrapedProduct.specs,
        sourceType: task.source.type,
        sourceUrl: task.url,
        sourceName: scrapedProduct.displayName,
        normalizedSourceName,
      });

      return {
        model: await this.productRepo.save(existingModel),
        created: false,
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

    model.productCategory = scrapedProduct.category;
  }

  private getProductRelations(): string[] {
    return [
      nameOf<ProductModel>("productCategory"),
      nameOf<ProductModel>("mainImage"),
      nameOf<ProductModel>("images"),
      nameOf<ProductModel>("embedding"),
      nameOf<ProductModel>("sources"),
    ];
  }

  private isNormalizedNameConflict(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes("duplicate key value") &&
      error.message.includes(this.normalizedNameConstraint)
    );
  }

  private async generateProductSlug(entity: ProductModel): Promise<void> {
    const brandName = entity.brand?.name ?? "";
    let slug = generateSlug(
      entity.id,
      brandName,
      entity.model || entity.displayName,
    );
    const existing = await this.productRepo.findOne({
      where: { slug },
      select: ["id"],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + "-" + entity.id.slice(-6);
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
        "Brand could not be identified, skipping product creation",
        {
          taskId: task.id,
          url: task.url,
          displayName: scrapedProduct.displayName,
        },
      );

      throw new Error("Brand could not be identified");
    }

    const model = new ProductModel();
    model.productCategory = scrapedProduct.category;

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
        category: model.productCategory?.name,
      });

    return model;
  }
}
