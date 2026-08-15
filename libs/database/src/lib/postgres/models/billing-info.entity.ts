import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Seller } from './seller.entity';

@Entity()
export class BillingInfo extends BasePostgresEntity {
  @OneToOne(() => Seller, (seller) => seller.billingInfo, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn()
  seller: Seller;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column()
  legalName: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  taxId?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  registrationNumber?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column()
  billingAddressLine1: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  billingAddressLine2?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column()
  city: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column()
  postalCode: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ default: 'HU' })
  country: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  bankAccountNumber?: string;
}
