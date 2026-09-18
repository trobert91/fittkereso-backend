import { User, UserRole } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose } from 'class-transformer';
import { BasePageResult } from './base-page-result';

export class UserSearchResult extends BasePageResult<User> {
  @Expose({ groups: [SerializeGroup.list] })
  searchTerm?: string;

  @Expose({ groups: [SerializeGroup.list] })
  roles?: UserRole[];

  @Expose({ groups: [SerializeGroup.list] })
  passwordChangeRequired?: boolean;
}
