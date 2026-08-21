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
   * CDN-uploaded images, offers keyed by (seller, sourceListingId)); this
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
   * Digest of scrapedProduct.rawSpecs, computed via hashRawSpecs. Kept as
   * its own column (not read out of scrapedProduct) so a re-scrape can
   * cheaply detect an unchanged spec table and skip re-extraction —
   * see ProductDetailsPageScraperService.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  rawSpecsHash?: string;

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
   * buildNormalizedSourceName), kept as its own indexed column so Path-1
   * identity lookup (findAllByNormalizedName) can query it directly instead
   * of recomputing normalization for every row on every scrape.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  normalizedSourceName?: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => Offer, (offer) => offer.sourceRecord)
  offers?: Offer[];
}
