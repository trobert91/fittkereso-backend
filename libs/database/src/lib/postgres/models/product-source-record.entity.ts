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
// Page dispatch and a list card without a usable id look a record up by
// (source, url). Not unique: a URL change moves a record, and two listings
// may share a page.
@Index(['source', 'url'])
// One record per (source, externalId): every import finds and writes its
// listing's record by it, and identity's Path 3 asks the same pair. Manual/
// admin rows carry source: null and no externalId; Postgres treats NULLs as
// distinct, so they are unconstrained here.
@Unique(['source', 'externalId'])
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
   * This listing's URL, normalized (see normalizeUrl): where it is fetched
   * from, and where its offer links. Not its identity: a shop renaming the
   * product changes it, and the next import moves the record to the new URL
   * (ProductSourceRecordUpdaterService.moveUrl). `externalId` is the key.
   *
   * Several sources can hold a record of one product page (a page scraper
   * and an Árukereső feed, say), so a URL lookup must be source-scoped
   * (findBySourceAndUrl).
   *
   * The plain index serves a url-only predicate, which the composite one
   * above, leading with sourceId, cannot.
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
   * The listing's key within its source (listingExternalIdOf): its
   * source-native id (SKU, product code, feed identifier), or the slug of its
   * URL when the source has none. Names exactly one listing, so it is unique
   * per source; a size group's shared id belongs in the listing's
   * siblingExternalIds. Stable across URL changes, which is why records are
   * found by it rather than by `url`.
   *
   * Null only on the admin's record.
   */
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
   * new products. Null on the records of a source that does not identify
   * products: nothing matches on them.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  normalizedSourceName?: string | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => Offer, (offer) => offer.sourceRecord)
  offers?: Offer[];
}
