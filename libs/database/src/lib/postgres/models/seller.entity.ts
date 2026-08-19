import { Column, Entity, Index, OneToMany, OneToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { SellerType } from '../types/seller-type';
import { ProductSource } from './product-source.entity';
import { BillingInfo } from './billing-info.entity';
import { Offer } from './offer.entity';

@Entity()
export class Seller extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ unique: true })
  name: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  slug?: string | null;

  @Expose({ groups: [SerializeGroup.list] })
  @Index()
  @Column({ type: 'enum', enum: SellerType, nullable: false })
  type: SellerType;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: true })
  domains?: string[];

  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ type: 'varchar', nullable: true })
  logoUrl?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  contactEmail?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  contactPhone?: string;

  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ type: 'varchar', nullable: true })
  location?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => ProductSource, (source) => source.seller)
  productSources: ProductSource[];

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToOne(() => BillingInfo, (billingInfo) => billingInfo.seller, {
    nullable: true,
  })
  billingInfo?: BillingInfo;

  @Expose({ groups: [SerializeGroup.list, SerializeGroup.adminList] })
  @Column({ nullable: false, default: false })
  verified: boolean;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ nullable: false, default: true })
  active: boolean;

  @OneToMany(() => Offer, (offer) => offer.seller)
  offers: Offer[];
}
