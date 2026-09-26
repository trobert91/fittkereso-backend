import type { ProductSourceRecordRow, ProductSpecs } from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

/** One offer-level spec of a listing (size, colour…), labelled from its category's schema. */
export interface ListingOfferSpec {
  key: string;
  /** The schema's title for the key, else the key itself. */
  label: string;
  unit?: string;
  /** Every value its offer entries state, once each, in entry order. */
  values: ProductSpecs[string][];
}

/** One listing as the admin list shows it: its offer entries' specs summed up and labelled. */
export type ProductSourceRecordListItem = Omit<ProductSourceRecordRow, 'offerEntrySpecs'> & {
  offerSpecs: ListingOfferSpec[];
};

export class ProductSourceRecordSearchResult extends BasePageResult<ProductSourceRecordListItem> {}
