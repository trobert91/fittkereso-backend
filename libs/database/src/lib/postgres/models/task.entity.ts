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

  @Column('float', { nullable: true })
  executionTimeInSec?: number;

  @Column({ type: 'boolean', default: false })
  deleteAfterSuccess: boolean;
}
