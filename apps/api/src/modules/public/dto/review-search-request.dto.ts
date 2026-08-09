import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import {
  Depth,
  ExperienceBucket,
  ExperienceType,
  Intent,
  Sentiment,
} from "@ebike-backend/database";
import { ReviewSortBy } from "./review-query.dto";

const ALLOWED_EXPERIENCE_VALUES = [
  ...Object.values(ExperienceType),
  ...Object.values(ExperienceBucket),
];

export type LabelSentimentBucket = "positive" | "negative";

export class ReviewSearchRequestDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
  @IsOptional() @IsEnum(ReviewSortBy) sortBy?: ReviewSortBy;
  @IsOptional() @IsEnum(["asc", "desc"]) sortDir?: "asc" | "desc";

  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsString() creationTsFrom?: string;
  @IsOptional() @IsString() creationTsTo?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(Sentiment, { each: true })
  sentiments?: Sentiment[];
  @IsOptional() @IsArray() @IsEnum(Intent, { each: true }) intents?: Intent[];
  @IsOptional()
  @IsArray()
  @IsIn(ALLOWED_EXPERIENCE_VALUES, { each: true })
  experiences?: (ExperienceType | ExperienceBucket)[];
  @IsOptional() @IsArray() @IsEnum(Depth, { each: true }) depths?: Depth[];

  @IsOptional() @IsArray() @IsString({ each: true }) features?: string[];
  @IsOptional()
  @IsIn(["positive", "negative"])
  featureSentiment?: LabelSentimentBucket;

  @IsOptional() @IsArray() @IsString({ each: true }) useCases?: string[];
  @IsOptional()
  @IsIn(["positive", "negative"])
  useCaseSentiment?: LabelSentimentBucket;

  @IsOptional() @IsArray() @IsString({ each: true }) issues?: string[];

  @IsOptional() @IsBoolean() includeAggregations?: boolean;
}
