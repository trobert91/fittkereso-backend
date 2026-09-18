import { Entity, Column, Index } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { QueueName } from '../types/queues';
import { IsDate } from 'class-validator';

export enum TaskStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

@Entity()
export class Task extends BasePostgresEntity {
  @Index()
  @Column({ type: 'enum', enum: QueueName, nullable: false })
  queue: QueueName;

  @Column({ type: 'jsonb', nullable: true })
  payload?: any;

  @Index()
  @Column({
    type: 'enum',
    enum: TaskStatus,
    nullable: false,
    default: TaskStatus.PENDING,
  })
  status: TaskStatus;

  @Index()
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Index()
  @Column({ nullable: true, type: 'timestamptz', default: null })
  @IsDate()
  scheduledAt?: Date | null; // support delayed tasks

  @Column({ nullable: true, type: 'timestamptz', default: null })
  @IsDate()
  lastRunAt?: Date;

  @Column({ nullable: true, type: 'timestamptz', default: null })
  @IsDate()
  lockedAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  error?: any;

  /**
   * This task failed for a reason that retrying cannot change, so nothing will
   * claim it again.
   *
   * The claim query normally re-picks a FAILED task while attempts remain,
   * which is right for a timeout or a flaky vendor and wrong for a malformed
   * product source config: the same config is read for the same answer, three
   * times, behind an exponential backoff, and the only thing that fixes it is
   * somebody editing the config — which queues fresh work anyway.
   */
  @Index()
  @Column({ type: 'boolean', nullable: false, default: false })
  terminal: boolean;

  @Column('float', { nullable: true })
  executionTimeInSec?: number;

  @Column({ type: 'boolean', default: false })
  deleteAfterSuccess: boolean;
}
