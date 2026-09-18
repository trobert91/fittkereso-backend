import { Column, Entity, Index } from 'typeorm';
import { Expose } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { UserRole } from '../../models/user-roles';

/**
 * An admin account.
 *
 * Identity lives in Supabase; this row is the local mirror of it and the
 * authority on what the account may do. Two ids are in play on purpose:
 *
 * - `id` is ours, generated here, and is what future history/audit rows
 *   should reference. Keeping it independent means re-pointing a Supabase
 *   project never orphans attribution.
 * - `authUserId` is the Supabase `sub`, used to resolve the row from a JWT.
 *
 * Table name is `app_user` because `user` is a reserved word in Postgres and
 * would need quoting in every hand-written query and psql script.
 */
@Entity('app_user')
export class User extends BasePostgresEntity {
  /** Supabase auth user id (the `sub` claim). */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: false })
  authUserId: string;

  /** Always stored lower-cased: GoTrue lower-cases addresses, and we match by equality. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: false })
  email: string;

  /** Defaults to empty - an account can exist before anyone gives it a name. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: false, default: '' })
  name: string;

  /**
   * The sole authority on this account's access level. It is mirrored into
   * Supabase app_metadata for the frontend's benefit, but the backend only
   * ever reads it from here.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Index()
  @Column({ type: 'enum', enum: UserRole, nullable: false, default: UserRole.user })
  role: UserRole;

  /**
   * Set when an account is created with a temporary password. While true the
   * account is held at the set-password page and every other route is refused.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'boolean', nullable: false, default: false })
  passwordChangeRequired: boolean;

  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  lastSignInAt?: Date | null;
}
