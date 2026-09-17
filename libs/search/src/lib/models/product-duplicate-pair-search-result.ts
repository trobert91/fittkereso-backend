import { ProductDuplicatePair } from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

export class ProductDuplicatePairSearchResult extends BasePageResult<ProductDuplicatePair> {
  status?: 'open' | 'dismissed';

  categoryIds?: string[];

  minScore?: number;

  maxScore?: number;
}
