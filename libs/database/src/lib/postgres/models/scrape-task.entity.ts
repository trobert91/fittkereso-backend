import { Entity, Column, Index, ManyToOne } from 'typeorm';
import { Expose } from 'class-transformer';
import { BasePostgresEntity } from './base-postgres-entity';
import { TaskStatus } from './task.entity';
import { ProductSource } from './product-source.entity';
import { ProductModel } from './product-model.entity';
import { ScrapeQueueName } from '../types';
import { IsDate } from 'class-validator';
import { SerializeGroup } from '@fittkereso-backend/utils';
import type { ResolutionContext as PersistedResolutionContext } from '../../models/resolution-context';

@Entity()
export class ScrapeTask extends BasePostgresEntity {
  @Index()
  @Column({ type: 'enum', enum: ScrapeQueueName, nullable: false })
  @Expose({ groups: [SerializeGroup.list] })
  queue: ScrapeQueueName;

  @ManyToOne(() => ProductSource, (source) => source.tasks, {
    nullable: false,
  })
  @Expose({ groups: [SerializeGroup.list] })
  source: ProductSource;

  @ManyToOne(() => ProductModel, (model) => model.scrapeTasks, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  product?: ProductModel | null;

  @Column({ unique: false })
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  url: string;

  @Index()
  @Column({
    type: 'enum',
    enum: TaskStatus,
    nullable: false,
    default: TaskStatus.PENDING,
  })
  @Expose({ groups: [SerializeGroup.list] })
  status: TaskStatus;

  @Index()
  @Column({ type: 'integer', default: 0 })
  @Expose({ groups: [SerializeGroup.list] })
  attempts: number;

  @Index()
  @Column({ nullable: true, type: 'timestamptz', default: null })
  @IsDate()
  @Expose({ groups: [SerializeGroup.list] })
  scheduledAt?: Date | null; // support delayed tasks

  @Column({ nullable: true, type: 'timestamptz', default: null })
  @IsDate()
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  lastRunAt?: Date;

  @Column({ nullable: true, type: 'timestamptz', default: null })
  @IsDate()
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  lockedAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  error?: any;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  resolutionContext?: PersistedResolutionContext | null;

  @Column('float', { nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  executionTimeInSec?: number;
}
