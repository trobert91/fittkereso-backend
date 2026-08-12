import { Injectable } from '@nestjs/common';
import {
  EvaluatedProduct,
  ProductModel,
  ProductModelRepository,
  ProductResolutionInput,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { In } from 'typeorm';
import { ProductEmbeddingService } from '../product-embedding.service';

@Injectable()
export class ProductEmbeddingMatchService {
  private readonly logger = new CustomLogger(ProductEmbeddingMatchService.name);

  constructor(
    private readonly embeddingService: ProductEmbeddingService,
    private readonly productModelRepo: ProductModelRepository,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  /**
   * Main entry point: Find the best matching product using embeddings.
   */
  public async findMatches(
    input: ProductResolutionInput,
    categoryIds?: string[],
    brandIds?: string[],
  ): Promise<EvaluatedProduct[]> {
    const mentionEmbedding = await this.embeddingService.createProductEmbedding(
      {
        brand: input.brand,
        model: input.model,
        displayName: input.displayName,
        category: input.category?.name ?? input.categoryHint,
      },
    );

    const candidates = await this.searchNearestProducts(
      mentionEmbedding,
      this.resultLimit,
      categoryIds,
      brandIds,
    );

    return candidates.map((c) => this.toEvaluated(c));
  }

  /**
   * Query nearest products from Postgres using pgvector.
   *
   * Two-phase approach: first query gets product IDs + similarity scores
   * (without one-to-many alias join that breaks TypeORM's .take() pagination),
   * then loads full entities with all relations.
   */
  private async searchNearestProducts(
    embedding: number[],
    limit: number,
    categoryIds?: string[],
    brandIds?: string[],
  ): Promise<
    {
      entity: ProductModel;
      similarity: number;
    }[]
  > {
    const embeddingLiteral = `[${embedding.join(',')}]`;

    // Phase 1: Get product IDs and similarity scores (no one-to-many joins)
    const qb = this.productModelRepo.repo
      .createQueryBuilder('pm')
      .innerJoin(`pm.${nameOf<ProductModel>('embedding')}`, 'e')
      .select(`pm.${nameOf<ProductModel>('id')}`, 'product_id')
      .addSelect('1 - (e.embedding <=> :embeddingQuery)', 'similarity')
      .where('1 - (e.embedding <=> :embeddingQuery) > :threshold')
      .orderBy('similarity', 'DESC')
      .limit(limit)
      .setParameter('embeddingQuery', embeddingLiteral)
      .setParameter('threshold', this.similarityThreshold);

    if (categoryIds?.length) {
      qb.andWhere('pm.productCategoryId IN (:...categoryIds)', {
        categoryIds,
      });
    }

    if (brandIds?.length) {
      qb.andWhere('pm.brandId IN (:...brandIds)', {
        brandIds,
      });
    }

    const rows = await qb.getRawMany<{
      product_id: string;
      similarity: string;
    }>();

    if (rows.length === 0) return [];

    const similarityById = new Map<string, number>();
    for (const row of rows) {
      const parsedSimilarity = parseFloat(row.similarity);
      if (!Number.isNaN(parsedSimilarity)) {
        similarityById.set(row.product_id, parsedSimilarity);
      }
    }

    // Phase 2: Load full entities with all relations (brand, category, aliases)
    const productIds = [...similarityById.keys()];
    const entities = await this.productModelRepo.repo.find({
      where: { id: In(productIds) },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('aliases'),
      ],
    });

    return entities.map((entity) => ({
      entity,
      similarity: similarityById.get(entity.id) ?? 0,
    }));
  }

  /**
   * Convert candidate into EvaluatedProduct.
   */
  private toEvaluated(candidate: {
    entity: ProductModel;
    similarity: number;
  }): EvaluatedProduct {
    return {
      id: candidate.entity.id,
      model: candidate.entity.model,
      brand: candidate.entity.brand?.name,
      brandId: candidate.entity.brand?.id,
      displayName: candidate.entity.displayName,
      confidence: candidate.similarity,
      category: candidate.entity.productCategory,
      specs: candidate.entity.specs,
      aliases: candidate.entity.aliases?.map((alias) => alias.alias),
      releaseYear: candidate.entity.releaseYear,
      source: 'embedding',
    };
  }

  private get similarityThreshold(): number {
    return (
      this.dynamicConfig.resolution?.embeddingSimilarityThreshold ??
      RESOLUTION_DEFAULTS.embeddingSimilarityThreshold
    );
  }

  private get resultLimit(): number {
    return (
      this.dynamicConfig.resolution?.embeddingResultLimit ??
      RESOLUTION_DEFAULTS.embeddingResultLimit
    );
  }
}
