import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose, Transform } from 'class-transformer';
import {
  SerializeGroup,
  nameOf,
  transfromExposeAll,
} from '@fittkereso-backend/utils';
import { ProductModel } from './product-model.entity';
import { Seller } from './seller.entity';
import { ProductSourceRecord } from './product-source-record.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';
import { ProductSpecs } from '../../models/product-spec';

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

  /**
   * The specific listing this offer belongs to — carries both the source
   * site (via sourceRecord.source) and that listing's URL/specs, so callers
   * don't need a second join to get from an offer to its source.
   */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @ManyToOne(() => ProductSourceRecord, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @Index()
  sourceRecord?: ProductSourceRecord | null;

  @Expose({ groups: [SerializeGroup.list] })
  @Index()
  @Column({ type: 'enum', enum: OfferCondition, nullable: false })
  condition: OfferCondition;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: false })
  price: number;

  /**
   * The pre-discount price, only set when the source lists this offer at a
   * discount (i.e. a strikethrough/original price alongside the current
   * one). Absent whenever the offer isn't currently discounted.
   */
  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  priceWithoutDiscount?: number;

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

  /**
   * Offer-scoped spec values (e.g. frameSize, color) — the subset of the
   * category's spec keys flagged via ProductCategoryConfig.offerLevelSpecs.
   * Always optional: a listing may not surface any, or only some, of these
   * values (e.g. frameSize known but color not extractable from this source)
   * — absence must never block creating/matching the Offer itself.
   */
  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'jsonb', nullable: true })
  @Transform(transfromExposeAll())
  specs?: ProductSpecs;
}
