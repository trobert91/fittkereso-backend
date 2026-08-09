import { Entity, Column, Index } from "typeorm";
import { Expose } from "class-transformer";
import { IsDate } from "class-validator";
import { SerializeGroup } from "@ebike-backend/utils";
import { BasePostgresEntity } from "./base-postgres-entity";
import { TaskStatus } from "./task.entity";
import { ThreadPlatform } from "../types/source-enums";

@Entity()
export class ThreadSearchTask extends BasePostgresEntity {
  @Column({ length: 256 })
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  keyword: string;

  @Column({ type: "enum", enum: ThreadPlatform, nullable: false })
  @Expose({ groups: [SerializeGroup.list] })
  platform: ThreadPlatform;

  @Column({ length: 128 })
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  categorySlug: string;

  @Index()
  @Column({
    type: "enum",
    enum: TaskStatus,
    nullable: false,
    default: TaskStatus.PENDING,
  })
  @Expose({ groups: [SerializeGroup.list] })
  status: TaskStatus;

  @Index()
  @Column({ type: "integer", default: 0 })
  @Expose({ groups: [SerializeGroup.list] })
  attempts: number;

  @Index()
  @Column({ nullable: true, type: "timestamptz", default: null })
  @IsDate()
  @Expose({ groups: [SerializeGroup.list] })
  scheduledAt?: Date | null;

  @Column({ nullable: true, type: "timestamptz", default: null })
  @IsDate()
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  lastRunAt?: Date;

  @Column({ nullable: true, type: "timestamptz", default: null })
  @IsDate()
  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  lockedAt?: Date;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  error?: unknown;

  @Column("float", { nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  executionTimeInSec?: number;

  /** Threads matched to an existing thread (keyword appended). Accumulated across runs. */
  @Column({ type: "integer", default: 0 })
  @Expose({ groups: [SerializeGroup.list] })
  duplicates: number;

  /** New threads accepted into the pipeline (ThreadStatus.NEW). Accumulated across runs. */
  @Column({ type: "integer", default: 0 })
  @Expose({ groups: [SerializeGroup.list] })
  discovered: number;

  /** New threads persisted below the relevance gate (ThreadStatus.LOW_ESTIMATION). Accumulated across runs. */
  @Column({ type: "integer", default: 0 })
  @Expose({ groups: [SerializeGroup.list] })
  belowRelevance: number;
}
