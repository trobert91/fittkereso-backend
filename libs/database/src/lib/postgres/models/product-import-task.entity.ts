import { Entity, Column, Index, ManyToOne, Check, BeforeInsert } from 'typeorm';
import { Expose } from 'class-transformer';
import { BasePostgresEntity } from './base-postgres-entity';
import { TaskStatus } from './task.entity';
import { ProductSource } from './product-source.entity';
import { ProductModel } from './product-model.entity';
import { ProductImportTaskKind } from '../types';
import { IsDate } from 'class-validator';
import { nameOf, SerializeGroup } from '@fittkereso-backend/utils';
import type { ListingMatchDecision } from '../../models/listing-match-decision';

export const MIN_IMPORT_TASK_PRIORITY = 0;
export const MAX_IMPORT_TASK_PRIORITY = 100;
/** What an import run's own tasks get: a scheduled or manual full sync. */
export const DEFAULT_IMPORT_TASK_PRIORITY = 50;
/** What a person's task gets — an admin resync or create, an MCP enqueue — unless they pass one. */
export const MANUAL_IMPORT_TASK_PRIORITY = 90;

/**
 * Seconds per `sortKey` bucket. Within a bucket, tasks run in random order;
 * an older bucket always runs before a newer one of the same priority, so a
 * steady stream of new work cannot starve a task queued earlier.
 */
export const IMPORT_TASK_SORT_BUCKET_SECONDS = 3600;

/** A task's place within its priority: its creation bucket, plus a random fraction. */
export const importTaskSortKey = (createdAt = new Date()): number =>
  Math.floor(createdAt.getTime() / 1000 / IMPORT_TASK_SORT_BUCKET_SECONDS) +
  Math.random();

/**
 * One unit of product import: a list page or a detail page to scrape, or an
 * Árukereső feed row to import. The collector's scheduler claims a batch of these every tick — higher priority
 * first, then by `sortKey` — and runs them concurrently.
 */
@Entity()
@Check(
  `"${nameOf<ProductImportTask>('priority')}" BETWEEN ${MIN_IMPORT_TASK_PRIORITY} AND ${MAX_IMPORT_TASK_PRIORITY}`,
)
@Index([nameOf<ProductImportTask>('priority'), nameOf<ProductImportTask>('sortKey')])
export class ProductImportTask extends BasePostgresEntity {
  @Index()
  @Column({ type: 'enum', enum: ProductImportTaskKind, nullable: false })
  @Expose({ groups: [SerializeGroup.list] })
  kind: ProductImportTaskKind;

  /** 0–100, higher runs first. See DEFAULT_ and MANUAL_IMPORT_TASK_PRIORITY. */
  @Column({ type: 'smallint', default: DEFAULT_IMPORT_TASK_PRIORITY })
  @Expose({ groups: [SerializeGroup.list] })
  priority: number;

  /**
   * Order within a priority: the creation bucket plus a random fraction (see
   * importTaskSortKey), set on insert. Rows from before the column existed
   * hold 0, so they run first.
   */
  @Column({ type: 'double precision', default: 0 })
  sortKey: number;

  @BeforeInsert()
  protected assignSortKey(): void {
    if (!this.sortKey) {
      this.sortKey = importTaskSortKey();
    }
  }

  @ManyToOne(() => ProductSource, (source) => source.importTasks, {
    nullable: false,
  })
  @Expose({ groups: [SerializeGroup.list] })
  source: ProductSource;

  @ManyToOne(() => ProductModel, (model) => model.importTasks, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  product?: ProductModel | null;

  @Column({ unique: false })
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  url: string;

  /**
   * The listing's externalId as its list card stated it, on a detail task
   * queued from a card. The page fetched from `url` must state the same one:
   * a shop that never 404s (ebikeshop) redirects a delisted product's URL to
   * another product, and importing that page would file it under this card.
   * Null where no card said (a card without one, a variant link, a manual task).
   */
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  externalId?: string | null;

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

  /**
   * This task failed for a reason that retrying cannot change, so nothing will
   * claim it again. See Task.terminal — same flag, same reasoning.
   *
   * Exposed on the list group so a failed task can be shown as settled rather
   * than as one still working through its attempts.
   */
  @Index()
  @Column({ type: 'boolean', nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.list] })
  terminal: boolean;

  /** What listing matching decided for this scrape. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  identityDecision?: ListingMatchDecision | null;

  /**
   * A `feed_entry` task's work: the raw feed row and the categories its run
   * was narrowed to. Mapped again when the task runs, with the source's config
   * of that moment. Not selected by default — a few KB each, and only the
   * processor needs it.
   */
  @Column({ type: 'jsonb', nullable: true, select: false })
  // `any`, not `unknown`: unknown values break TypeORM's deep-partial entity types.
  payload?: Record<string, any> | null;

  /**
   * The feed row's hash when it was queued (see feedRowHash). A later run of
   * the feed replaces a still-pending task's payload when its row changed, and
   * leaves one already running with the same row alone.
   */
  @Column({ type: 'varchar', nullable: true })
  payloadHash?: string | null;

  @Column('float', { nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  executionTimeInSec?: number;

  @Column({ type: 'boolean', default: false })
  @Expose({ groups: [SerializeGroup.list] })
  force?: boolean;
}
