import { Expose } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';

export class MainImageDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  url: string;
}
