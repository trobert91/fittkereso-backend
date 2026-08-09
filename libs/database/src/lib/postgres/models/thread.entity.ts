import { Column, Entity, Index, OneToMany } from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { UserComment } from "./user-comment.entity";
import { ThreadProductCategory } from "./thread-product-category.entity";
import { ThreadRun } from "./thread-run.entity";
import { ThreadStatus } from "../types/status-enums";
import { ThreadPlatform } from "../types/source-enums";
import { CommentMedia } from "../../models/comment-media";
import { CommentTree } from "../../models/tree-models";
import { RelevanceResult } from "../../models/thread-relevance-result";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";

@Index(["externalId", "source"], { unique: false })
// TODO: make unique after testing
// @Index(['externalId', 'source'], { unique: true })
@Entity()
export class Thread extends BasePostgresEntity {
  @Index({ unique: false })
  @Column()
  @Expose({ groups: [SerializeGroup.list] })
  externalId: string;

  @Index()
  @Column({
    type: "enum",
    enum: ThreadPlatform,
    nullable: false,
    default: ThreadPlatform.Reddit,
  })
  @Expose({ groups: [SerializeGroup.list] })
  source: ThreadPlatform;

  @Index()
  @Column()
  @Expose({ groups: [SerializeGroup.list] })
  title: string;

  @Index()
  @Column()
  @Expose({ groups: [SerializeGroup.list] })
  topic: string;

  @OneToMany(() => ThreadProductCategory, (tc) => tc.thread, { cascade: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  categories: ThreadProductCategory[];

  @Column({ nullable: true })
  @Expose({ groups: [SerializeGroup.details, SerializeGroup.adminDetails] })
  author?: string;

  @Column({ type: "text", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  url: string;

  @Column({ type: "text", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  text: string;

  @OneToMany(() => UserComment, (comment) => comment.thread, {
    cascade: false,
  })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  comments: UserComment[];

  @Column({ type: "jsonb", nullable: true, select: false })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  commentTree?: CommentTree | null;

  @Column({ type: "int", nullable: true })
  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  relevanceEstimation?: number;

  @Column({ type: "int", nullable: true })
  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  relevance?: number | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  relevanceResult?: RelevanceResult;

  @Column({ type: "int", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  commentCount?: number | null;

  @Column({ type: "timestamptz", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  lastSynced?: Date | null;

  @Index()
  @Column({
    type: "enum",
    enum: ThreadStatus,
    nullable: false,
    default: ThreadStatus.NEW,
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  status: ThreadStatus;

  @Index()
  @Column({ nullable: false, default: false })
  markedForSync: boolean;

  @Index()
  @Column({ nullable: false, default: false })
  processRunning: boolean;

  @Index()
  @Column({ nullable: false, default: false })
  preprocessingFailed: boolean;

  @Column({ type: "text", nullable: true })
  opSummary?: string | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  media?: CommentMedia[] | null;

  @Column({ type: "timestamptz", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  threadCreatedAt?: Date;

  @Index()
  @Column({ type: "timestamptz", nullable: true })
  lastProcessedAt?: Date | null;

  /**
   * Keywords that have discovered this thread via the keyword-research search
   * pipeline. Appended (set semantics) each time a new keyword surfaces the
   * thread. GIN-indexed via migration for efficient aggregation when computing
   * keyword performance stats.
   */
  @Column({ type: "text", array: true, default: () => "'{}'" })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  keywords: string[];

  @OneToMany(() => ThreadRun, (run) => run.thread, { cascade: false })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  runs: ThreadRun[];
}
