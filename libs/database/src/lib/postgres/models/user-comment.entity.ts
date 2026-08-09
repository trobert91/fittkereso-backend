import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  Index,
  JoinColumn,
} from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { Thread } from "./thread.entity";
import { ProductReference } from "./product-reference.entity";
import { CommentStatus, ModerationStatus } from "../types/status-enums";
import { Expose, Type } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { CommentContext, CommentMedia, CommentModeration } from "../../models";

@Entity()
export class UserComment extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne(() => Thread, (thread) => thread.comments, {
    onDelete: "CASCADE",
    nullable: false,
  })
  @JoinColumn({ name: "threadId" })
  thread: Thread;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "enum", enum: CommentStatus, default: CommentStatus.NEW })
  status: CommentStatus;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({
    type: "enum",
    enum: CommentStatus,
    enumName: "user_comment_status_enum",
    nullable: true,
  })
  lastProcessedStatus?: CommentStatus | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ nullable: false })
  externalId: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne(() => UserComment, (comment) => comment.children, {
    onDelete: "SET NULL",
  })
  parent?: UserComment;

  @OneToMany(() => UserComment, (comment) => comment.parent)
  children: UserComment[];

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ nullable: true })
  authorId?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ nullable: true })
  authorName?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ nullable: true })
  url?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column()
  body: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: "text", nullable: true })
  bodyHtml: string | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: "int" })
  upvotes: number;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: "int" })
  downvotes: number;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @CreateDateColumn({
    type: "timestamptz",
    nullable: true,
    default: () => "NULL",
  })
  externalCreationTs?: Date;

  @Expose({ groups: [SerializeGroup.adminList] })
  @OneToMany(() => ProductReference, (reference) => reference.comment, {
    cascade: ["insert", "update"],
  })
  productReferences?: ProductReference[];

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "float", nullable: true })
  relevance?: number;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  issueSeverity?: number;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  openIssueSeverity?: number;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "float", nullable: true })
  moderationPriority?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "boolean", nullable: false, default: false })
  validated?: boolean;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({
    type: "enum",
    enum: CommentStatus,
    enumName: "user_comment_status_enum",
    nullable: true,
  })
  validationDecision?: ModerationStatus;

  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  @Type(() => CommentModeration)
  @Column({ type: "jsonb", nullable: true })
  moderations?: CommentModeration[] | null;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  bucket?: number;

  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "jsonb", nullable: true })
  checkedByUserId?: string[];

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  media?: CommentMedia[] | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({
    type: "jsonb",
    nullable: true,
    transformer: CommentContext.transformer,
  })
  context?: CommentContext | null;
}
