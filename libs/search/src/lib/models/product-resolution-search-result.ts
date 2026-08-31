import { ProductResolution } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose, Type } from 'class-transformer';
import { BasePageResult } from './base-page-result';

export class ProductResolutionSearchResult extends BasePageResult<ProductResolution> {
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Type(() => ProductResolution)
  override items?: ProductResolution[];
}
