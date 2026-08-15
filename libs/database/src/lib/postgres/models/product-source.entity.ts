import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { ScrapeTask } from './scrape-task.entity';
import { Seller } from './seller.entity';
import { ProductSourceConfig } from '../types/product-source-config';
import ms from 'ms';

@Entity()
export class ProductSource extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ unique: true })
  name: string;

  // Nullable: aggregator/reference sources (e.g. a price-comparison site or a
  // spec-reference site) don't correspond to a single storefront seller. This FK
  // is for sources that ARE one seller's own site.
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @ManyToOne(() => Seller, (seller) => seller.productSources, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  seller?: Seller | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: false, default: '{}' })
  @Transform(transfromExposeAll())
  config: ProductSourceConfig;

  @OneToMany(() => ScrapeTask, (task) => task.source)
  tasks: ScrapeTask[];

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
  fullSyncInterval?: ms.StringValue;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  nextFullSyncAt?: Date;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  lastFullSyncAt?: Date;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'text', nullable: true })
  incrementalSyncInterval?: ms.StringValue;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  nextIncrementalSyncAt?: Date;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'timestamptz', nullable: true })
  lastIncrementalSyncAt?: Date;
}
