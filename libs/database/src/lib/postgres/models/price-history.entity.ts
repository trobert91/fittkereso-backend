import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose } from 'class-transformer';
import { SerializeGroup, nameOf } from '@fittkereso-backend/utils';
import { ProductModel } from './product-model.entity';
import { Offer } from './offer.entity';
import { OfferCondition } from '../types/offer-condition';

@Entity()
@Index([
  nameOf<PriceHistory>('model'),
  nameOf<PriceHistory>('condition'),
  nameOf<PriceHistory>('observedAt'),
])
export class PriceHistory extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list] })
  @ManyToOne(() => ProductModel, (model) => model.priceHistory, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @Index()
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne(() => Offer, { nullable: true, onDelete: 'SET NULL' })
  offer?: Offer | null;

  @Expose({ groups: [SerializeGroup.list] })
  @Index()
  @Column({ type: 'enum', enum: OfferCondition, nullable: false })
  condition: OfferCondition;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: false })
  price: number;

  @Expose({ groups: [SerializeGroup.list] })
  @Column()
  currency: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Index()
  @Column({ type: 'timestamptz', nullable: false })
  observedAt: Date;
}
