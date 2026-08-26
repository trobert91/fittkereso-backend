import { Offer } from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

export class OfferSearchResult extends BasePageResult<Offer> {
  productId?: string;
}
