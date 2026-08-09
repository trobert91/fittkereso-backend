import { Column, Entity, Index, ManyToOne } from "typeorm";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { BasePostgresEntity } from "./base-postgres-entity";
import { Thread } from "./thread.entity";

export enum ThreadRunStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
}

export interface ThreadRunModelUsage {
  model: string;
  provider: string | null;
  callCount: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ThreadRunStepStats {
  costUsd: number;
  llmCallCount: number;
  retryCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  durationMs?: number;
}

export interface ThreadRunOpSummarizationStep extends ThreadRunStepStats {
  summarized: boolean;
}

export interface ThreadRunProductIdentificationStep extends ThreadRunStepStats {
  mentionsIdentified: number;
}

export interface ThreadRunExtractionStep extends ThreadRunStepStats {
  quoteCount: number;
  intentLabelsApplied: number;
}

export interface ThreadRunLabelingStep extends ThreadRunStepStats {
  featureLabelsApplied: number;
  useCaseLabelsApplied: number;
  issueCount: number;
  issuesByType?: Record<string, number>;
}

export interface ThreadRunProductResolutionStep extends ThreadRunStepStats {
  productReferenceCount: number;
  productReferencesEnabled: number;
  productReferencesResolved: number;
  productReferencesDeferred: number;
  distinctProductsResolved: number;
  distinctProductsInRegistry: number;
}

export interface ThreadRunValidationStep extends ThreadRunStepStats {
  decisions: { approved: number; inReview: number; deleted: number };
  issueCount: number;
  unresolvedIssueCount: number;
}

export interface ThreadRunDetails {
  thread: {
    commentCount: number;
    commentsProcessed: number;
    commentsSkipped: number;
    commentsIdentified: number;
    subtreeCount: number;
  };
  steps: {
    opSummarization: ThreadRunOpSummarizationStep;
    productIdentification: ThreadRunProductIdentificationStep;
    extraction: ThreadRunExtractionStep;
    labeling: ThreadRunLabelingStep;
    productResolution: ThreadRunProductResolutionStep;
    validation: ThreadRunValidationStep;
    relevance: ThreadRunStepStats;
    imageAnalysis: ThreadRunStepStats;
    translation: ThreadRunStepStats;
    other: ThreadRunStepStats;
  };
  models: {
    totalLlmCallCount: number;
    usage: ThreadRunModelUsage[];
  };
}

export interface ThreadRunError {
  message: string;
  name?: string;
}

@Entity()
export class ThreadRun extends BasePostgresEntity {
  @ManyToOne(() => Thread, (thread) => thread.runs, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @Index()
  thread: Thread;

  @Index()
  @Column({
    type: "enum",
    enum: ThreadRunStatus,
    default: ThreadRunStatus.RUNNING,
  })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  status: ThreadRunStatus;

  @Index()
  @Column({ type: "timestamptz" })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  startedAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  completedAt: Date | null;

  @Column({ type: "integer", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  durationMs: number | null;

  @Column({ type: "double precision", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  totalCostUsd: number | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  details: ThreadRunDetails | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  error: ThreadRunError | null;
}
