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
// Serves the product-detail freshness query: this model's offers, filtered by
// lastSynced against the visibility cutoff.
@Index([nameOf<Offer>('model'), nameOf<Offer>('lastSynced')])
@Unique([nameOf<Offer>('seller'), nameOf<Offer>('externalId')])
export class Offer extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list] })
  // `disable`: saving a ProductModel with a loaded, stale offers array must
  // never detach a row another writer attached meanwhile. TypeORM's default
  // (`nullify`) sets modelId to NULL on every row the array does not list.
  @ManyToOne(() => ProductModel, (model) => model.offers, {
    nullable: false,
    onDelete: 'CASCADE',
    orphanedRowAction: 'disable',
  })
  @Index()
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.list] })
  @ManyToOne(() => Seller, (seller) => seller.offers, { nullable: false })
  @Index()
  seller: Seller;

  /**
   * The listing that supplied this offer's price — the highest-priority
   * current record of the seller that lists it (OfferComposerService). Carries
   * the source (via sourceRecord.source) and that listing's URL/specs, so
   * callers don't need a second join. On a seller with several sources, the
   * other fields may come from other records.
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
  priceWithoutDiscount?: number | null;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ default: 'HUF' })
  currency: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: 'varchar', nullable: true })
  url?: string | null;

  /**
   * Stock status, when the source gives grounds for one at all.
   *
   * Nullable, and null is distinct from `unknown`. Null means no source has
   * given us any basis for a stock claim; `unknown` means a source DID report
   * something and it was a value we could not map onto one of the four states —
   * the second is a config bug worth fixing, the first is not. Neither should
   * be read as "in stock".
   *
   * What counts as grounds depends on the importer, and the two differ for a
   * real reason. A scraped product page exists whether or not the thing is
   * orderable, so silence there is genuinely an absence of information. A feed
   * is generated from what the shop is currently offering, so a product's mere
   * presence in it means it can be bought — which is why the Árukereső importer
   * defaults to `in_stock` and only departs from it when the feed says
   * otherwise (Árukereső's documented `DeliveryTime: "NO"`).
   */
  @Expose({ groups: [SerializeGroup.list] })
  @Column({
    type: 'enum',
    enum: OfferAvailability,
    nullable: true,
  })
  availability?: OfferAvailability | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  externalId?: string;

  /**
   * This offer's barcode, as a checksum-validated GTIN-14 (see normalizeGtin
   * in @fittkereso-backend/utils) — null when the source publishes none or an
   * invalid one. The raw value survives on the source record's scrapedProduct.
   *
   * Lives on the offer, not the product, because a GTIN identifies one
   * sellable SIZE, and an offer is per size. It is the one identifier that is
   * the same at every shop, so a new listing whose GTIN matches another
   * shop's offer is looked up onto that offer's product.
   *
   * Indexed for that lookup, and deliberately not unique: one shop can list
   * the same item twice, and a disagreement is something to review, not a
   * write to refuse.
   */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Index()
  @Column({ type: 'varchar', length: 14, nullable: true })
  gtin?: string | null;

  /**
   * The manufacturer's article number for this size (normalizeMpn: upper
   * case, no whitespace or hyphens) — null when the source publishes none.
   *
   * Only comparable within one brand, and only between shops that publish
   * the manufacturer's code rather than their own: KTM's codes agree across
   * shops, CUBE's do not. Indexed and not unique, for the same reasons as
   * `gtin`.
   */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Index()
  @Column({ type: 'varchar', nullable: true })
  mpn?: string | null;

  /**
   * Store/warehouse names where this offer is physically available (e.g.
   * ["Törökbálinti raktár", "Törökbálint"]) — always optional, most sources
   * have no per-location breakdown.
   */
  @Expose({ groups: [SerializeGroup.details] })
  @Column({ type: 'jsonb', nullable: true })
  locations?: string[] | null;

  /**
   * When an import run last confirmed this offer on the source.
   *
   * The single freshness signal in the system: the public site shows offers
   * synced within `offers.freshnessDays` (7), and StaleOfferSweepService
   * hard-deletes those untouched for `offers.deleteAfterDays` (14). Time-based
   * staleness is deliberately the whole mechanism — there are no miss counters
   * and no delisting sweep; a source that stops seeing a product simply stops
   * stamping it.
   *
   * Nullable, and null reads as "not confirmed recently": such rows are hidden
   * from the site but never swept, because `lastSynced < cutoff` is false for
   * NULL. That is what makes rows written before this column existed safe.
   *
   * Do NOT gate visibility on `active` instead — nothing in production ever
   * sets it to false, so every `active = true` guard is a no-op.
   */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  lastSynced?: Date | null;

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
   *
   * Also on `adminDetails`, for the Duplicates page: a 53cm against a 48cm of
   * the same bike is a variant rather than a duplicate, so these values are
   * often the whole answer, and that list is served without `details`.
   */
  @Expose({ groups: [SerializeGroup.details, SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: true })
  @Transform(transfromExposeAll())
  specs?: ProductSpecs;
}
