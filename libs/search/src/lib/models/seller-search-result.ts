import { Seller, SellerType } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose } from 'class-transformer';
import { BasePageResult } from './base-page-result';

export class SellerSearchResult extends BasePageResult<Seller> {
  @Expose({ groups: [SerializeGroup.list] })
  searchTerm?: string;

  @Expose({ groups: [SerializeGroup.list] })
  types?: SellerType[];

  @Expose({ groups: [SerializeGroup.list] })
  verified?: boolean;

  @Expose({ groups: [SerializeGroup.list] })
  active?: boolean;
}
