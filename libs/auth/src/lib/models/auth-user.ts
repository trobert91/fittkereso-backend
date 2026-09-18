import { UserRole } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose } from 'class-transformer';

/** The caller, resolved from a verified token plus their local app_user row. */
export class AuthenticatedUser {
  /** Local app_user id - the one future history rows should reference. */
  @Expose({ groups: [SerializeGroup.list] })
  id: string;

  /** Supabase auth user id. */
  @Expose({ groups: [SerializeGroup.list] })
  authUserId: string;

  @Expose({ groups: [SerializeGroup.list] })
  email: string;

  @Expose({ groups: [SerializeGroup.list] })
  name: string;

  @Expose({ groups: [SerializeGroup.list] })
  role: UserRole;

  @Expose({ groups: [SerializeGroup.list] })
  passwordChangeRequired: boolean;
}
