import { OrderedSpec, ProductSpecs } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose, Type } from 'class-transformer';
import { BasePageResult } from './base-page-result';

export class DuplicatePairItem {
  @Expose({ groups: [SerializeGroup.list] })
  id: string;

  @Expose({ groups: [SerializeGroup.list] })
  displayName: string;

  @Expose({ groups: [SerializeGroup.list] })
  normalizedName: string;

  @Expose({ groups: [SerializeGroup.list] })
  brandName: string;

  @Expose({ groups: [SerializeGroup.list] })
  brandId?: string;

  @Expose({ groups: [SerializeGroup.list] })
  orderedSpecs?: OrderedSpec[];

  @Expose({ groups: [SerializeGroup.list] })
  specs?: ProductSpecs;

  @Expose({ groups: [SerializeGroup.list] })
  model?: string;

  @Expose({ groups: [SerializeGroup.list] })
  releaseYear?: number;

  @Expose({ groups: [SerializeGroup.list] })
  createdAt?: Date;
}

export class DuplicatePair {
  @Expose({ groups: [SerializeGroup.list] })
  @Type(() => DuplicatePairItem)
  productA: DuplicatePairItem;

  @Expose({ groups: [SerializeGroup.list] })
  @Type(() => DuplicatePairItem)
  productB: DuplicatePairItem;

  @Expose({ groups: [SerializeGroup.list] })
  similarityScore: number;

  @Expose({ groups: [SerializeGroup.list] })
  categoryName: string;

  @Expose({ groups: [SerializeGroup.list] })
  categoryId: string;
}

export class DuplicateSearchResult extends BasePageResult<DuplicatePair> {
  @Expose({ groups: [SerializeGroup.list] })
  @Type(() => DuplicatePair)
  override items?: DuplicatePair[];
}
