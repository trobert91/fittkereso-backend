import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';
import { ProductSource } from './product-source.entity';
import { ScrapedProduct } from '../../models/scraped-product';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { Offer } from './offer.entity';

@Entity()
@Index(['model', 'source'])
@Index(['source', 'productSpecsHash'])
export class ProductSourceRecord extends BasePostgresEntity {
  @ManyToOne(() => ProductModel, (model) => model.sources, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @ManyToOne(() => ProductSource, { nullable: true, onDelete: 'SET NULL' })
  @Index()
  source?: ProductSource | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true, unique: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  url?: string;

  /**
   * The complete ScrapedProduct this source record was built from — full
   * provenance/replay copy, including this source's specs/rawSpecs (read
   * via scrapedProduct.specs/scrapedProduct.rawSpecs — there are no
   * separate top-level columns for those, to avoid two divergent copies of
   * "what did this source actually say"), brand/model/displayName/aliases/
   * releaseYear/imageUrls/offers. ProductModel/ProductImage/Offer hold the
   * resolved, deduped, cross-source-merged results (brand FK lookup,
   * CDN-uploaded images, offers keyed by (seller, externalId)); this
   * column is the pre-resolution source claim those were built from, kept
   * so ProductMergeService.mergeSources can recompute ProductModel's specs
   * and identity fields from sources without a re-scrape.
   *
   * Partial for manual/admin-entered rows (source: null): those only ever
   * carry `specs`, never brand/category/etc.
   */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Transform(transfromExposeAll())
  scrapedProduct?: Partial<ScrapedProduct>;

  /**
   * Digest of exactly the raw spec rows (+ raw title) fed to the
   * offer/identity post-process call (see hashOfferSpecs in
   * @fittkereso-backend/utils) — the source's offerLevelSpecsInputs-selected
   * rows plus the raw model/title text. Lets a re-scrape of the same listing
   * skip that call when unchanged — see ProductDetailsPageScraperService.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  offerSpecsHash?: string;

  /**
   * Digest of the raw spec rows fed to the model-spec (product-identity)
   * post-process call — the full raw spec table minus whatever
   * offerSpecsHash already covers (see hashProductSpecs). Deliberately
   * disjoint from offerSpecsHash's input so an offer-level-only difference
   * between sibling variant pages never invalidates this half of the cache.
   * Also the key used to find a SIBLING ProductSourceRecord (same source,
   * different URL/listing) whose already-unified product-identity specs can
   * be reused outright — see
   * ProductSourceRecordRepository.findBySourceAndProductSpecsHash.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  productSpecsHash?: string;

  /**
   * Source-native listing identifier (SKU/model code/slug), stable across URL
   * changes. Used to recognize an already-known listing independent of
   * `url` matching byte-for-byte.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  externalId?: string;

  @Column({ nullable: true, default: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  specValid?: boolean;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Transform(transfromExposeAll())
  specErrors?: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: false })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  lastUpdated: Date;

  @Column({ type: 'boolean', nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  deduplicated: boolean;

  /**
   * Normalized identity key derived from scrapedProduct.{brand,model,
   * displayName} at scrape time (see ProductScrapeUpdaterService.
   * buildNormalizedSourceName). Also feeds ProductModel.normalizedName on
   * new products.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  normalizedSourceName?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => Offer, (offer) => offer.sourceRecord)
  offers?: Offer[];
}
