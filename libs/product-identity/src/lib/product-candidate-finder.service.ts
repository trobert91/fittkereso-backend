import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { compact, groupBy, isEmpty, keyBy, orderBy } from 'lodash';
import {
  NameSimilarity,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { applyGates, scoreOf } from './gates';
import { TokenIdf, baseScore, nameSimilarity } from './name-similarity';
import { CandidateRecallService, RecallRow } from './candidate-recall.service';
import { ProductMatchQueryService } from './product-match-query.service';
import { TokenIdfService } from './token-idf.service';
import type { ProductCandidate, ProductMatchQuery } from './types';

interface ScoredRow {
  row: RecallRow;
  candidateKey: string;
  similarity: NameSimilarity;
  base: number;
}

/**
 * Finds and scores the stored products a query could be. Returns every
 * recalled candidate, best first, with its score and failed gates — thresholds
 * are the callers' (listing match, duplicate detection), so a low score stays
 * visible. Only reads.
 */
@Injectable()
export class ProductCandidateFinderService {
  constructor(
    private readonly recall: CandidateRecallService,
    private readonly productRepo: ProductModelRepository,
    private readonly queryService: ProductMatchQueryService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly tokenIdf: TokenIdfService,
  ) {}

  public async findCandidates(
    query: ProductMatchQuery,
  ): Promise<ProductCandidate[]> {
    const rows = (await this.recall.recall(query)).filter(
      (row) => row.productId !== query.productId,
    );
    if (isEmpty(rows)) return [];

    // Only worth a query once something was recalled to score.
    const idf = await this.tokenIdf.forScope(query.brandId, query.categoryId);
    const bestRows = this.bestRowPerProduct(query, rows, idf);
    if (isEmpty(bestRows)) return [];

    const products = keyBy(
      await this.productRepo.find({
        where: { id: In(bestRows.map(({ row }) => row.productId)) },
        select: { id: true, displayName: true, createdAt: true, specs: true },
      }),
      (product) => product.id,
    );
    const categoryConfig = this.categoryConfigService.getConfig(
      query.categorySlug,
    );

    const candidates = compact(
      bestRows.map(({ row, candidateKey, similarity, base }) => {
        // Missing when the product was deleted between recall and load.
        const product = products[row.productId];
        if (!product) return undefined;

        const failedGates = applyGates({
          queryKey: query.nameKey,
          candidateKey,
          querySpecs: query.specs,
          candidateSpecs: product.specs,
          categoryConfig,
        });

        return {
          productId: product.id,
          displayName: product.displayName,
          createdAt: product.createdAt,
          score: scoreOf(base, failedGates),
          matchedOn: row.matchedOn,
          matchedValue: row.matchedValue,
          nameSimilarity: similarity,
          failedGates,
          specs: product.specs,
        };
      }),
    );

    return orderBy(
      candidates,
      [(candidate) => candidate.score, (candidate) => candidate.createdAt],
      ['desc', 'asc'],
    );
  }

  /**
   * Scores each row on its name and keeps each product's best, preferring its
   * name row on a tie. Aliases are stored raw or keyed by another rule, so
   * they're re-keyed the way the query key was built before Levenshtein.
   */
  private bestRowPerProduct(
    query: ProductMatchQuery,
    rows: RecallRow[],
    idf: TokenIdf,
  ): ScoredRow[] {
    const scored = rows.map((row): ScoredRow => {
      const candidateKey =
        row.matchedOn === 'alias'
          ? this.queryService.nameKeyOf({
              brandName: query.brandName,
              model: row.matchedValue,
              categorySlug: query.categorySlug,
            })
          : row.matchedValue;
      const similarity = nameSimilarity(query.nameKey, candidateKey, idf);
      return { row, candidateKey, similarity, base: baseScore(similarity) };
    });

    return Object.values(groupBy(scored, ({ row }) => row.productId)).map(
      (group) =>
        orderBy(
          group,
          [({ base }) => base, ({ row }) => row.matchedOn === 'name'],
          ['desc', 'desc'],
        )[0],
    );
  }
}
