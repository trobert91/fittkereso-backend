import { Expose, Type } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import {
  Sentiment,
  Intent,
  ExperienceType,
  Depth,
  ThreadPlatform,
  ContentQuality,
} from "@ebike-backend/database";

/** Structured evidence entry shared by features and use cases on the ref DTO. */
export class EvidenceDto {
  @Expose({ groups: [SerializeGroup.details] }) label: string;
  @Expose({ groups: [SerializeGroup.details] }) sentiment?: Sentiment;
}

export class ReviewQuoteDto {
  @Expose({ groups: [SerializeGroup.details] }) text: string;
  @Expose({ groups: [SerializeGroup.details] }) sentiment: Sentiment;
  /** Feature labels evidenced by this quote. */
  @Expose({ groups: [SerializeGroup.details] }) features?: string[];
  /** Use case labels evidenced by this quote. */
  @Expose({ groups: [SerializeGroup.details] }) useCases?: string[];
  /** Closed-list issue labels evidenced by this quote. */
  @Expose({ groups: [SerializeGroup.details] }) issues?: string[];
  /** Quote quality tier — used by clients to rank quotes within a review. */
  @Expose({ groups: [SerializeGroup.details] }) quality?: ContentQuality;
}

export class ReviewDetailsDto {
  @Expose({ groups: [SerializeGroup.details] }) returned?: boolean;
  @Expose({ groups: [SerializeGroup.details] }) defective?: boolean;
  @Expose({ groups: [SerializeGroup.details] }) multipleUnits?: boolean;
}

export class ReviewReferenceDto {
  @Expose({ groups: [SerializeGroup.details] }) id: string;
  @Expose({ groups: [SerializeGroup.details] }) commentBody?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) topic?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) threadTitle?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) externalUrl?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) sentiment?: Sentiment | null;
  @Expose({ groups: [SerializeGroup.details] }) intents?: Intent[];
  @Expose({ groups: [SerializeGroup.details] })
  experience?: ExperienceType | null;
  @Expose({ groups: [SerializeGroup.details] }) depth?: Depth | null;
  @Expose({ groups: [SerializeGroup.details] }) upvotes: number;
  @Expose({ groups: [SerializeGroup.details] }) downvotes: number;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ReviewQuoteDto)
  quotes: ReviewQuoteDto[];
  /**
   * Combined view of every feature label associated with this reference —
   * union of ref-level LLM emits and per-quote (non-speculative) evidence.
   * Sentiment is set on every entry; split positive/negative client-side.
   */
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => EvidenceDto)
  features?: EvidenceDto[] | null;
  /** Combined view of every use-case label associated with this reference. */
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => EvidenceDto)
  useCases?: EvidenceDto[] | null;
}

export class ReviewDto {
  @Expose({ groups: [SerializeGroup.details] }) id: string;
  @Expose({ groups: [SerializeGroup.details] }) sentiment: Sentiment;
  @Expose({ groups: [SerializeGroup.details] }) experience: ExperienceType;
  @Expose({ groups: [SerializeGroup.details] }) depth: Depth;
  @Expose({ groups: [SerializeGroup.details] }) intents: Intent[];
  @Expose({ groups: [SerializeGroup.details] }) totalUpvotes: number;
  @Expose({ groups: [SerializeGroup.details] }) totalDownvotes: number;
  @Expose({ groups: [SerializeGroup.details] }) creationTs: Date;
  @Expose({ groups: [SerializeGroup.details] })
  platform?: ThreadPlatform | null;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ReviewQuoteDto)
  quotes: ReviewQuoteDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ReviewDetailsDto)
  reviewDetails?: ReviewDetailsDto | null;
}

export class ReviewParentCommentDto {
  @Expose({ groups: [SerializeGroup.details] }) body: string;
  @Expose({ groups: [SerializeGroup.details] }) authorName?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) externalUrl?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) upvotes: number;
  @Expose({ groups: [SerializeGroup.details] })
  externalCreationTs?: Date | null;
}

export class ReviewDetailReferenceDto extends ReviewReferenceDto {
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ReviewParentCommentDto)
  parentComments: ReviewParentCommentDto[];
}

export class ReviewDetailDto extends ReviewDto {
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ReviewDetailReferenceDto)
  parts: ReviewDetailReferenceDto[];
}
