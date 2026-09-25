import { Column, Entity, Index, ManyToOne, OneToMany, Unique } from 'typeorm';
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
// One record per (source, url). Manual/admin rows carry source: null and no
// url; Postgres treats NULLs as distinct, so they are unconstrained here.
@Unique(['source', 'url'])
export class ProductSourceRecord extends BasePostgresEntity {
  /** The product this listing currently sits on. Exposed to `adminList` because
   *  the resolution review queue's whole job is showing where a listing ended
   *  up — a merge can move it after the decision was recorded.
   *
   *  Null for an unattached listing: a row of a source that does not identify
   *  products, whose offer the seller's identifying source has not created yet
   *  (or has removed). It attaches once that offer exists. */
  @Expose({ groups: [SerializeGroup.adminList] })
  // `disable`: saving a ProductModel with a loaded, stale sources array must
  // never detach a row another writer attached meanwhile. TypeORM's default
  // (`nullify`) sets modelId to NULL on every row the array does not list.
  @ManyToOne(() => ProductModel, (model) => model.sources, {
    nullable: true,
    onDelete: 'CASCADE',
    orphanedRowAction: 'disable',
  })
  model: ProductModel | null;

  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => ProductSource, { nullable: true, onDelete: 'SET NULL' })
  @Index()
  source?: ProductSource | null;

  /**
   * This listing's URL, normalized (see normalizeUrl).
   *
   * Unique PER SOURCE, not globally — one webshop may be covered by several
   * ProductSources (a page scraper and an Árukereső feed, say), and both
   * legitimately hold a record for the same product page, each with its own
   * provenance in `scrapedProduct` and its own spec hashes. A global unique
   * made the second source unable to store anything it had already seen.
   *
   * Consequence for callers: every URL lookup here must be source-scoped
   * (findBySourceAndUrl). A bare url match can return another source's row, and
   * writing through it silently overwrites that source's data.
   *
   * The plain index is deliberate and separate: the composite unique below
   * leads with sourceId, so it cannot serve a url-only predicate.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  url?: string;

  /**
   * The complete ScrapedProduct this source record was built from — full
   * provenance/replay copy, including this source's specs/rawSpecs (read
   * via scrapedProduct.specs/scrapedProduct.rawSpecs — there are no
   * separate top-level columns for those, to avoid two divergent copies of
   * "what did this source actually say"), brand/model/displayName/aliases/
   * images/offers. ProductModel/ProductImage/Offer hold the
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
   * Digest of the offer-level subset of the deterministic spec mapping fed
   * to the offer-identity post-process call (see hashSpecs/
   * filterDefinedSpecs in @fittkereso-backend/utils) — computed once in
   * ProductDetailsPageScraperService.extractProduct and persisted here as
   * given, not recomputed, so the hash used to decide "unchanged since last
   * scrape" and the hash stored here can never silently diverge. Lets a
   * re-scrape of the same listing skip that call when unchanged.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  offerSpecsHash?: string;

  /**
   * Digest of the product-identity subset of the deterministic spec mapping
   * fed to the model-spec post-process call — the complement of whatever
   * offerSpecsHash covers (see hashSpecs/filterDefinedSpecs). Deliberately
   * disjoint from offerSpecsHash's input so an offer-level-only difference
   * between sibling variant pages never invalidates this half of the cache.
   * Computed once alongside offerSpecsHash and persisted as given — see its
   * doc comment. Together with offerSpecsHash and scrapedProduct's
   * identityInputHash, it decides whether a re-import may reuse this record's
   * identity extraction (SpecPostProcessService.extractIdentity).
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  productSpecsHash?: string;

  /**
   * An Árukereső listing's feed row as last imported, hashed after mapping
   * (see feedRowHash). A feed run compares each row against it: the same hash
   * only refreshes the listing's offer in place, anything else becomes an
   * import task. Null for scraped listings.
   */
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  feedRowHash?: string | null;

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

  /**
   * When this source last listed the item: every import of the listing and
   * every sighting of an unchanged feed row or list card. Only a source that
   * still lists an item may overwrite the seller's offer (OfferComposerService).
   * Null on rows written before the column existed, and on the admin's record;
   * readers fall back to lastUpdated.
   */
  @Column({ type: 'timestamptz', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  lastSeenAt?: Date | null;

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
