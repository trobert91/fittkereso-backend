import {
  Depth,
  ExperienceType,
  Intent,
  Sentiment,
  ThreadPlatform,
} from "@ebike-backend/database";
import {
  IsString,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
  IsBoolean,
  IsNumber,
} from "class-validator";

export class ReviewSearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsEnum(Sentiment, { each: true })
  sentiments?: Sentiment[];

  @IsOptional()
  @IsEnum(Intent, { each: true })
  intents?: Intent[];

  @IsOptional()
  @IsEnum(ExperienceType, { each: true })
  experiences?: ExperienceType[];

  @IsOptional()
  @IsEnum(Depth, { each: true })
  depths?: Depth[];

  @IsOptional()
  @IsEnum(ThreadPlatform, { each: true })
  platforms?: ThreadPlatform[];

  @IsOptional()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  productSlug?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  includeDeleted?: boolean;

  @IsOptional()
  @IsNumber()
  minReviewScore?: number;

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
    "reviewScore",
    "totalUpvotes",
    "totalDownvotes",
    "sentiment",
    "experience",
    "depth",
    "externalCreationTs",
    "createdAt",
    "updatedAt",
    "partCount",
  ])
  sort?:
    | "reviewScore"
    | "totalUpvotes"
    | "totalDownvotes"
    | "sentiment"
    | "experience"
    | "depth"
    | "externalCreationTs"
    | "createdAt"
    | "updatedAt"
    | "partCount";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";
}
