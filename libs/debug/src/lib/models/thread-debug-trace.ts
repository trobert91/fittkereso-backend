import { ProcessingTraceData } from './processing-trace-data';

export interface ThreadMetadata {
  id: string;
  title: string;
  topic: string;
  category?: string;
  url: string;
}

export interface ModelUsageStats {
  calls: number;
  cost: number;
  tokens: number;
  cachedTokens: number;
}

export interface AggregateStats {
  totalComments: number;
  tracedComments: number;
  passedRelevance: number;
  skipped: number;
  approved: number;
  inReview: number;
  deleted: number;
  llmCalls: number;
  totalCost: number;
  totalDurationMs: number;
  modelBreakdown: Record<string, ModelUsageStats>;
}

export interface CommentSummaryRow {
  index: number;
  commentId: string;
  externalId: string;
  status: string;
  relevance?: number;
  productCount: number;
  flags: number;
  durationMs: number;
  cost: number;
  issue?: string;
  subtreeIndex?: number;
}

export interface Anomaly {
  type: 'flagged_reference' | 'moderation_issue' | 'error' | 'high_miss_rate' | 'subtree_budget_exceeded' | 'all_fast_path';
  commentId: string;
  externalId: string;
  description: string;
}

export interface SystemPromptInfo {
  hash: string;
  step: string;
  lineCount: number;
  content: string;
}

export interface ThreadLevelTrace {
  step: string;
  durationMs: number;
  cost: number;
  summary: string;
}

export interface SubtreeStats {
  subtreeCount: number;
  avgPlanNodes: number;
  avgContextNodes: number;
  opSummarized: boolean;
  opOriginalChars: number;
  opSummaryChars: number;
  extractionRetries: number;
  extractionTotal: number;
}

export interface ThreadTraceSummary {
  thread: ThreadMetadata;
  stats: AggregateStats;
  statusBreakdown: Record<string, number>;
  comments: CommentSummaryRow[];
  anomalies: Anomaly[];
  systemPrompts: Map<string, SystemPromptInfo>;
  configSnapshot?: Record<string, any>;
  threadLevelTraces?: ThreadLevelTrace[];
  subtreeStats?: SubtreeStats;
}

export interface PipelineStepTrace {
  step: string;
  iteration: number;
  statusBefore: string;
  statusAfter: string;
  durationMs: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cost?: number;
  costLabel?: string;
  data: ProcessingTraceData;
  timestamp: Date;
}

export interface ProductReferenceInfo {
  id: string;
  displayName: string;
  resolvedProduct?: {
    id: string;
    name: string;
    brand: string;
  };
  relevance: number;
  enabled: boolean;
  flagged: boolean;
}

export interface CommentDebugTrace {
  commentId: string;
  externalId: string;
  author: string;
  body: string;
  status: string;
  relevance?: number;
  reviewComment?: string;
  parentContext?: {
    id: string;
    externalId: string;
    body: string;
    grandparentBody?: string;
  };
  productReferences: ProductReferenceInfo[];
  pipelineSteps: PipelineStepTrace[];
}

export interface ThreadDebugTrace {
  thread: ThreadMetadata;
  stats: AggregateStats;
  anomalies: Anomaly[];
  systemPrompts: Map<string, SystemPromptInfo>;
  comments: CommentDebugTrace[];
}

// ── Batched Pipeline Debug Types ──────────────────────────────────────────────

export interface BatchDebugTrace {
  batchId: string;
  step: 'subtree_extraction' | 'subtree_validation';
  subtreeIndex: number;
  threadMetadata: ThreadMetadata;
  anchorTrace: PipelineStepTrace;
  commentResults: Array<{
    commentId: string;
    externalId?: string;
    author: string;
    status: string;
    costShare: number;
    mentions?: number;
    quotesExtracted?: number;
    validationOutcome?: string;
    issues?: string[];
  }>;
  totalCost: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface SubtreeMapDebugTrace {
  threadMetadata: ThreadMetadata;
  config: {
    softBudget: number;
    hardBudget: number;
    maxPlanNodes: number;
    maxDepth: number;
  };
  subtrees: Array<{
    index: number;
    planNodeCount: number;
    contextNodeCount: number;
    maxDepth: number;
    estimatedTokens: number;
    extractionBatchId?: string;
    validationBatchIds?: string[];
    nodes: Array<{
      commentId: string;
      externalId?: string;
      author: string;
      nodeType: 'PLAN' | 'CONTEXT';
      depth: number;
      bodyPreview: string;
    }>;
  }>;
}
