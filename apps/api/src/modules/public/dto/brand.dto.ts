import { Expose } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';

export class BrandDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  name: string;
}
