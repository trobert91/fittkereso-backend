import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { ScrapeTask } from './scrape-task.entity';
import { ProductImage } from './product-image.entity';
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

  @OneToMany(() => ProductImage, (image) => image.source)
  images: ProductImage[];

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt?: Date;

  @Column({ type: 'int', nullable: false, default: 1 })
  maxConcurrent: number;

  @Column({ type: 'int', nullable: false, default: 60 })
  requestsPerHour: number;

  @Column({ type: 'int', nullable: false, default: 10 })
  priority: number;

  @Index()
  @Column({ nullable: false, default: true })
  schedulingEnabled: boolean;

  @Column({ nullable: false, default: true })
  processingEnabled: boolean;

  @Column({ type: 'text', nullable: true })
  fullSyncInterval?: ms.StringValue;

  @Column({ type: 'timestamptz', nullable: true })
  nextFullSyncAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastFullSyncAt?: Date;

  @Column({ type: 'text', nullable: true })
  incrementalSyncInterval?: ms.StringValue;

  @Column({ type: 'timestamptz', nullable: true })
  nextIncrementalSyncAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastIncrementalSyncAt?: Date;
}
