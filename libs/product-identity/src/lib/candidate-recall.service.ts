import { Injectable } from '@nestjs/common';
import { isEmpty } from 'lodash';
import {
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import type { ProductMatchQuery } from './types';

/** One recall hit: a listing of a product, by its key. */
export interface RecallRow {
  productId: string;
  /** The listing's normalizedModel. */
  normalizedModel: string;
  /** The listing's model as written: what the model-number check reads. */
  model: string | null;
}

/**
 * The finder's SQL reads: listings of the query's brand and category whose
 * normalizedModel equals one of the query's keys (exact), or is
 * trigram-similar to one (fuzzy). Listings of a source that does not
 * identify products carry no key, so only identifying listings are found.
 *
 * Neither has a row limit: a brand's products in one category are few
 * enough to score every product the trigram cut-off lets through
 * (`pg_trgm.similarity_threshold`, 0.3), and a limit was measured to drop a
 * same-bike product behind its neighbours — trigram ranks "730 abs macina
 * style" above "730 easy entry macina style". The finder ranks by its own
 * score.
 */
@Injectable()
export class CandidateRecallService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  /** Listings whose key equals one of `keys`. */
  public async exact(query: ProductMatchQuery, keys: string[]): Promise<RecallRow[]> {
    if (isEmpty(keys)) return [];
    return this.read(query, `= ANY($1::text[])`, keys);
  }

  /** Listings whose key is trigram-similar to `key`, equal ones included. */
  public async fuzzy(query: ProductMatchQuery, key: string): Promise<RecallRow[]> {
    return this.read(query, `% $1`, key);
  }

  private async read(
    query: ProductMatchQuery,
    condition: string,
    value: string | string[],
  ): Promise<RecallRow[]> {
    const records = `"${this.sourceRecordRepo.repo.metadata.tableName}"`;
    const products = `"${this.productRepo.repo.metadata.tableName}"`;
    const productId = `"${nameOf<ProductSourceRecord>('product')}Id"`;
    const key = `"${nameOf<ProductSourceRecord>('normalizedModel')}"`;
    const model = `"${nameOf<ProductSourceRecord>('model')}"`;
    const brandId = `"${nameOf<ProductModel>('brand')}Id"`;
    const categoryId = `"${nameOf<ProductModel>('productCategory')}Id"`;

    return this.sourceRecordRepo.repo.query(
      `SELECT DISTINCT r.${productId} AS "productId", r.${key} AS "normalizedModel", r.${model} AS model
         FROM ${records} AS r
         JOIN ${products} AS pm ON pm.id = r.${productId}
        WHERE r.${key} ${condition}
          AND pm.${brandId} = $2 AND pm.${categoryId} = $3 AND pm.id IS DISTINCT FROM $4::uuid
        ORDER BY "productId", "normalizedModel", model`,
      [value, query.brandId, query.categoryId, query.productId ?? null],
    );
  }
}
