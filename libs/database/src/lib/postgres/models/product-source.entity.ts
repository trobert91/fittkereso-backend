import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { ScrapeTask } from './scrape-task.entity';
import { Seller } from './seller.entity';
import { ProductSourceConfig } from '../types/product-source-config';
import { ProductSourceVersion } from './product-source-version.entity';
import { ProductSourceAction } from './product-source-action.entity';
import ms from 'ms';

@Entity()
export class ProductSource extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ unique: true })
  name: string;

  // The one storefront seller this source's offers belong to — Offer.seller
  // is always derived from here, never from per-offer scrape data.
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @ManyToOne(() => Seller, (seller) => seller.productSources, {
    nullable: false,
  })
  seller: Seller;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: false, default: '{}' })
  @Transform(transfromExposeAll())
  config: ProductSourceConfig;

  @OneToMany(() => ScrapeTask, (task) => task.source)
  tasks: ScrapeTask[];

  /**
   * The config history and the audit trail, newest first.
   *
   * Declared as relations but NEVER loaded through `relations: {...}`: two
   * one-to-many collections joined in one query multiply into a cartesian
   * product, so a source with 40 versions and 300 actions would fetch 12,000
   * rows to render 340. The detail service loads each with its own ordered,
   * bounded query and assigns them here.
   *
   * They ride on the source itself rather than being fetched separately by the
   * client, so one response carries everything the details page renders — and
   * an update answers with the history it just changed, instead of the page
   * having to ask again and hope it asked late enough.
   *
   * Nothing cascades: these are append-only and written only by
   * ProductSourceVersionService, so saving a source can never rewrite them.
   */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => ProductSourceVersion, (version) => version.source)
  versions?: ProductSourceVersion[];

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => ProductSourceAction, (action) => action.source)
  actions?: ProductSourceAction[];

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt?: Date;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'int', nullable: false, default: 1 })
  maxConcurrent: number;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'int', nullable: false, default: 60 })
  requestsPerHour: number;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'int', nullable: false, default: 10 })
  priority: number;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Index()
  @Column({ nullable: false, default: true })
  schedulingEnabled: boolean;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ nullable: false, default: true })
  processingEnabled: boolean;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'text', nullable: true })
  fullSyncInterval?: ms.StringValue | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  nextFullSyncAt?: Date | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  lastFullSyncAt?: Date;
}
