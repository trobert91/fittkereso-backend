import { Injectable } from '@nestjs/common';
import { isEmpty } from 'lodash';
import {
  CandidateMatchedOn,
  ProductAlias,
  ProductAliasRepository,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { KEY_HITS, NAME_HITS } from './product-identity.constants';
import type { ProductMatchQuery } from './types';

/** One recall hit: a product's name key or one of its aliases, with its trigram similarity. */
export interface RecallRow {
  productId: string;
  matchedOn: CandidateMatchedOn;
  /** The stored name key or the raw alias; for a matcherModel hit, the product's name key. */
  matchedValue: string;
  trigram: number;
}

/**
 * The finder's one SQL read: products of the query's brand and category whose
 * name key or an alias is trigram-similar to the query key.
 *
 * Filters with `%`, which the GIN trigram indexes serve (`similarity() > x`
 * can't use them); its cut-off is `pg_trgm.similarity_threshold`, default 0.3.
 * `similarity()` only orders. Brand and category sit inside each half of the
 * union, and the limit counts rows, so one product can take several — the
 * finder keeps its best.
 */
@Injectable()
export class CandidateRecallService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  public async recall(query: ProductMatchQuery): Promise<RecallRow[]> {
    const products = `"${this.productRepo.repo.metadata.tableName}"`;
    const aliases = `"${this.aliasRepo.repo.metadata.tableName}"`;
    const normalizedName = `"${nameOf<ProductModel>('normalizedName')}"`;
    const brandId = `"${nameOf<ProductModel>('brand')}Id"`;
    const categoryId = `"${nameOf<ProductModel>('productCategory')}Id"`;
    const alias = `"${nameOf<ProductAlias>('alias')}"`;
    const modelId = `"${nameOf<ProductAlias>('model')}Id"`;
    const scope = `pm.${brandId} = $2 AND pm.${categoryId} = $3 AND pm.id IS DISTINCT FROM $4::uuid`;

    const rows: (Omit<RecallRow, 'trigram'> & { trigram: number | string })[] =
      await this.productRepo.repo.query(
        `SELECT pm.id AS "productId", 'name' AS "matchedOn", pm.${normalizedName} AS "matchedValue",
                similarity(pm.${normalizedName}, $1) AS trigram
         FROM ${products} AS pm
         WHERE pm.${normalizedName} % $1 AND ${scope}
         UNION ALL
         SELECT pm.id, 'alias', pa.${alias}, similarity(pa.${alias}, $1)
         FROM ${aliases} AS pa
         JOIN ${products} AS pm ON pm.id = pa.${modelId}
         WHERE pa.${alias} % $1 AND ${scope}
         ORDER BY trigram DESC
         LIMIT $5`,
        [
          query.nameKey,
          query.brandId,
          query.categoryId,
          query.productId ?? null,
          NAME_HITS,
        ],
      );

    return rows.map((row) => ({ ...row, trigram: Number(row.trigram) }));
  }

  /**
   * Products of the query's brand and category with a listing keyed like the
   * query (`matcherModelKey`), however far apart the names are: "Tour CX 830"
   * and "Macina Tour CX830" key alike and may not reach the trigram cut-off.
   * Each row carries the product's name key, so the finder scores it like a
   * name row. Its own limit, since the name arm's rows are capped at NAME_HITS.
   */
  public async recallByMatcherModel(query: ProductMatchQuery): Promise<RecallRow[]> {
    const keys = query.matcherModelKeys ?? [];
    if (isEmpty(keys)) return [];

    const products = `"${this.productRepo.repo.metadata.tableName}"`;
    const records = `"${this.sourceRecordRepo.repo.metadata.tableName}"`;
    const normalizedName = `"${nameOf<ProductModel>('normalizedName')}"`;
    const brandId = `"${nameOf<ProductModel>('brand')}Id"`;
    const categoryId = `"${nameOf<ProductModel>('productCategory')}Id"`;
    const modelId = `"${nameOf<ProductSourceRecord>('model')}Id"`;
    const key = `"${nameOf<ProductSourceRecord>('matcherModelKey')}"`;

    const rows: (Omit<RecallRow, 'trigram'> & { trigram: number | string })[] =
      await this.productRepo.repo.query(
        `SELECT DISTINCT pm.id AS "productId", 'matcherModel' AS "matchedOn", pm.${normalizedName} AS "matchedValue",
                similarity(pm.${normalizedName}, $1) AS trigram
         FROM ${records} AS r
         JOIN ${products} AS pm ON pm.id = r.${modelId}
         WHERE r.${key} = ANY($2::text[])
           AND pm.${brandId} = $3 AND pm.${categoryId} = $4 AND pm.id IS DISTINCT FROM $5::uuid
         ORDER BY trigram DESC
         LIMIT $6`,
        [query.nameKey, keys, query.brandId, query.categoryId, query.productId ?? null, KEY_HITS],
      );

    return rows.map((row) => ({ ...row, trigram: Number(row.trigram) }));
  }
}
