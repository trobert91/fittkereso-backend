import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { Expose } from 'class-transformer';
import { SerializeGroup, nameOf } from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { Seller } from './seller.entity';
import { User } from './user.entity';
import { SellerMemberRole } from '../types/seller-member-role';

/**
 * An account's role at one seller - the control-plane `memberships` pattern,
 * with Seller as the tenant.
 *
 * Both sides cascade: a membership is access, not history, so it has nothing
 * to say once either the account or the seller is gone.
 *
 * Two writers: the admin app (through this API) and the partner portal in
 * fittkereso-frontend, which writes this table directly as the
 * fittkereso_partner role. Renaming or dropping a column breaks the portal.
 */
@Entity()
@Unique([nameOf<SellerMembership>('user'), nameOf<SellerMembership>('seller')])
export class SellerMembership extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => User, (user) => user.memberships, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @Index()
  user: User;

  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => Seller, (seller) => seller.memberships, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @Index()
  seller: Seller;

  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'enum', enum: SellerMemberRole, nullable: false })
  role: SellerMemberRole;
}
