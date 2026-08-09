import {
  CommentStatus,
  Depth,
  ExperienceType,
  Sentiment,
} from "@ebike-backend/database";
import {
  IsString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
} from "class-validator";

export class CommentSearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  threadId?: string;

  @IsOptional()
  @IsString()
  authorId?: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsString({ each: true })
  reviewedBy?: string[];

  @IsOptional()
  @IsString()
  parentExternalId?: string;

  @IsOptional()
  @IsEnum(CommentStatus, { each: true })
  statuses?: CommentStatus[];

  @IsOptional()
  @IsEnum(Sentiment, { each: true })
  sentiments?: Sentiment[];

  @IsOptional()
  @IsEnum(ExperienceType, { each: true })
  experiences?: ExperienceType[];

  @IsOptional()
  @IsEnum(Depth, { each: true })
  depths?: Depth[];

  @IsOptional()
  @IsString()
  reviewer?: string;

  @IsOptional()
  dateRange?: [string | null, string | null];

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsEnum([
    "relevance",
    "status",
    "lastSynced",
    "createdAt",
    "updatedAt",
    "moderationPriority",
    "openIssueSeverity",
    "issueSeverity",
  ])
  sort?:
    | "relevance"
    | "status"
    | "lastSynced"
    | "createdAt"
    | "updatedAt"
    | "moderationPriority"
    | "openIssueSeverity"
    | "issueSeverity";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";

  @IsOptional()
  @IsNumber()
  @Min(0)
  minModerationPriority?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minOpenIssueSeverity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minIssueSeverity?: number;
}
