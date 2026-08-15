import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose } from 'class-transformer';
import { SerializeGroup, nameOf } from '@fittkereso-backend/utils';
import { ProductModel } from './product-model.entity';
import { Seller } from './seller.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';

@Entity()
@Index([nameOf<Offer>('model'), nameOf<Offer>('condition')])
@Unique([nameOf<Offer>('seller'), nameOf<Offer>('sourceListingId')])
export class Offer extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list] })
  @ManyToOne(() => ProductModel, (model) => model.offers, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @Index()
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.list] })
  @ManyToOne(() => Seller, (seller) => seller.offers, { nullable: false })
  @Index()
  seller: Seller;

  @Expose({ groups: [SerializeGroup.list] })
  @Index()
  @Column({ type: 'enum', enum: OfferCondition, nullable: false })
  condition: OfferCondition;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: false })
  price: number;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ default: 'HUF' })
  currency: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: 'varchar', nullable: true, unique: true })
  url?: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({
    type: 'enum',
    enum: OfferAvailability,
    nullable: false,
    default: OfferAvailability.unknown,
  })
  availability: OfferAvailability;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  sourceListingId?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: false })
  lastSeenAt: Date;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ nullable: false, default: true })
  active: boolean;

  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'int', nullable: true })
  mileageKm?: number;

  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'date', nullable: true })
  purchaseDate?: string;

  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'int', nullable: true })
  batteryHealthPercent?: number;

  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'text', nullable: true })
  serviceHistory?: string;

  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'text', nullable: true })
  usedConditionNotes?: string;
}
