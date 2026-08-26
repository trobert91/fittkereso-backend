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
