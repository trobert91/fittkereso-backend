import { ProductSource } from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

export class ProductSourceSearchResult extends BasePageResult<ProductSource> {
  searchTerm?: string;

  sellerId?: string;

  schedulingEnabled?: boolean;
}
