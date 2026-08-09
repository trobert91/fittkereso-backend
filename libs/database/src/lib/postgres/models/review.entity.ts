import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
} from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { ProductModel } from "./product-model.entity";
import type { ProductReferenceCandidate } from "./product-reference-candidate.entity";
import { ReviewLabel } from "./review-label.entity";
import { Depth, ExperienceType, Intent, Sentiment } from "../types/sentiment";
import { Expose, Transform } from "class-transformer";
import { SerializeGroup, transfromExposeAll } from "@ebike-backend/utils";
import { ThreadPlatform } from "../types/source-enums";
import type { Quote, ReviewDetails } from "../../models/comment-context";

@Index(["userId", "model"], { unique: true })
@Entity()
export class Review extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne(() => ProductModel, (model) => model.reviews, {
    nullable: false,
    onDelete: "CASCADE",
  })
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column()
  userId: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column()
  username: string;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(
    "ProductReferenceCandidate",
    (candidate: ProductReferenceCandidate) => candidate.review,
  )
  candidates?: ProductReferenceCandidate[];

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => ReviewLabel, (label) => label.review, {
    cascade: ["insert", "update"],
    orphanedRowAction: "delete",
  })
  labels?: ReviewLabel[];

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "boolean", nullable: false, default: true })
  enabled: boolean;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "enum", enum: Sentiment, nullable: false })
  sentiment: Sentiment;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({
    type: "enum",
    enum: ExperienceType,
    nullable: false,
  })
  experience: ExperienceType;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({
    type: "enum",
    enum: Intent,
    nullable: false,
    array: true,
  })
  intents: Intent[];

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @CreateDateColumn({ type: "timestamptz" })
  externalCreationTs?: Date;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "enum", enum: Depth, nullable: true })
  depth?: Depth;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "float", nullable: true })
  reviewScore?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  totalQuoteCount?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  partCount?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "int", nullable: true })
  totalUpvotes?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "int", nullable: true })
  totalDownvotes?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "timestamptz", nullable: true, default: null })
  deletedAt?: Date | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({
    type: "enum",
    enum: ThreadPlatform,
    nullable: false,
  })
  platform: ThreadPlatform;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  quotes?: Quote[] | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  reviewDetails?: ReviewDetails | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "timestamptz", nullable: true })
  lastEvaluatedAt?: Date | null;
}
