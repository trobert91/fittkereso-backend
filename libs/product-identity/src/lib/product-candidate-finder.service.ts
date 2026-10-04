import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { compact, flatten, groupBy, isEmpty, keyBy, maxBy, orderBy } from 'lodash';
import {
  NameSimilarity,
  ProductModelRepository,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { productDisplayName } from '@fittkereso-backend/utils';
import { applyGates, keyScoreOf, scoreOf } from './gates';
import { TokenIdf, baseScore, nameSimilarity } from './name-similarity';
import { CandidateRecallService, RecallRow } from './candidate-recall.service';
import { ProductMatchQueryService } from './product-match-query.service';
import { TokenIdfService } from './token-idf.service';
import type { ProductCandidate, ProductMatchQuery } from './types';

interface ScoredRow {
  row: RecallRow;
  /** The row's key equals one of the query's model keys. */
  keyMatch: boolean;
  similarity: NameSimilarity;
  base: number;
}

/** The keys a query is searched by, and whether they are model keys. */
interface QueryKeys {
  keys: string[];
  keyed: boolean;
}

export interface FindCandidatesOptions {
  /**
   * False: only candidates whose key equals one of the query's model keys —
   * the ones an equal key attaches, scored as the full search scores them.
   */
  fuzzy?: boolean;
}

/**
 * Finds and scores the stored products a query could be. Returns every
 * recalled candidate, best first, with its score and failed gates — thresholds
 * are the callers' (listing match, duplicate detection), so a low score stays
 * visible. Only reads.
 *
 * Recall reads the listings' normalizedModels: equal to a query key, or
 * trigram-similar to one. Each candidate is scored on its best listing's key
 * against the query's (name similarity, weighted by how rare each word is in
 * the brand), minus its failed gates; it also says whether a listing of it
 * has the query's key, and what its spec gates alone leave (`keyScore`), for
 * the attach rule.
 */
@Injectable()
export class ProductCandidateFinderService {
  constructor(
    private readonly recall: CandidateRecallService,
    private readonly productRepo: ProductModelRepository,
    private readonly queryService: ProductMatchQueryService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly tokenIdf: TokenIdfService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  public async findCandidates(
    query: ProductMatchQuery,
    { fuzzy = true }: FindCandidatesOptions = {},
  ): Promise<ProductCandidate[]> {
    const { keys, keyed } = await this.keysOf(query);
    if (isEmpty(keys) || (!fuzzy && !keyed)) return [];

    const rows = [
      ...(keyed ? await this.recall.exact(query, keys) : []),
      ...(fuzzy
        ? flatten(await Promise.all(keys.map((key) => this.recall.fuzzy(query, key))))
        : []),
    ].filter((row) => row.productId !== query.productId);
    if (isEmpty(rows)) return [];

    // Only worth a query once something was recalled to score.
    const idf = await this.tokenIdf.forScope(query.brandId, query.categoryId);
    const bestRows = this.bestRowPerProduct(keys, keyed, rows, idf);

    const loaded = await this.productRepo.find({
      where: { id: In(bestRows.map(({ row }) => row.productId)) },
      select: { id: true, model: true, createdAt: true, specs: true },
    });
    const products = keyBy(loaded, (product) => product.id);
    const categoryConfig = this.categoryConfigService.getConfig(query.categorySlug);

    const candidates = compact(
      bestRows.map(({ row, keyMatch, similarity, base }) => {
        // Missing when the product was deleted between recall and load.
        const product = products[row.productId];
        if (!product) return undefined;

        const failedGates = applyGates({
          queryModel: query.model,
          candidateModel: row.model ?? product.model,
          querySpecs: query.specs,
          candidateSpecs: product.specs,
          categoryConfig,
        });

        return {
          productId: product.id,
          // Every candidate is of the query's brand.
          displayName: productDisplayName(query.brandName, product.model),
          createdAt: product.createdAt,
          score: scoreOf(base, failedGates),
          matchedOn: keyMatch ? ('normalizedModel' as const) : ('trigram' as const),
          matchedValue: row.normalizedModel,
          nameSimilarity: similarity,
          failedGates,
          specs: product.specs,
          normalizedModelMatch: keyed ? keyMatch : undefined,
          keyScore: keyScoreOf(failedGates),
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
   * A listing's query carries its key; a stored product's keys are its
   * listings'. A product none of whose listings has a key is searched by its
   * own model's words, which attach nothing.
   */
  private async keysOf(query: ProductMatchQuery): Promise<QueryKeys> {
    if (query.keys) return { keys: query.keys, keyed: query.keyed ?? false };

    const stored = query.productId
      ? ((await this.sourceRecordRepo.findNormalizedModelsByProductIds([query.productId])).get(
          query.productId,
        ) ?? [])
      : [];
    if (!isEmpty(stored)) return { keys: stored, keyed: true };
    return {
      keys: compact([this.queryService.keyOfName(query.model, query.brandName)]),
      keyed: false,
    };
  }

  /**
   * Scores each row against the query key it is most like, and keeps each
   * product's best: a listing with the query's key first, then the highest
   * score.
   */
  private bestRowPerProduct(
    keys: string[],
    keyed: boolean,
    rows: RecallRow[],
    idf: TokenIdf,
  ): ScoredRow[] {
    const scored = rows.map((row): ScoredRow => {
      const similarity = maxBy(
        keys.map((key) => nameSimilarity(key, row.normalizedModel, idf)),
        baseScore,
      ) as NameSimilarity;
      return {
        row,
        keyMatch: keyed && keys.includes(row.normalizedModel),
        similarity,
        base: baseScore(similarity),
      };
    });

    return Object.values(groupBy(scored, ({ row }) => row.productId)).map(
      (group) =>
        orderBy(group, [({ keyMatch }) => keyMatch, ({ base }) => base], ['desc', 'desc'])[0],
    );
  }
}
