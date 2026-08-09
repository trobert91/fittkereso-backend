import { Expose } from 'class-transformer';
import type { CommentStatus } from '../postgres/types/status-enums';

export type CommentModerationSource = 'system' | 'admin' | 'validation_llm';

export class CommentModeration {
  @Expose()
  reviewedBy: string;

  @Expose()
  reviewComment?: string;

  @Expose()
  suggestedStatus?: CommentStatus;

  @Expose()
  createdAt: string;

  @Expose()
  source: CommentModerationSource;
}
