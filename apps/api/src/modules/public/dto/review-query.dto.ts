import { Transform, Type } from "class-transformer";
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import {
  Sentiment,
  Intent,
  ExperienceType,
  ExperienceBucket,
  Depth,
} from "@ebike-backend/database";

const ALLOWED_EXPERIENCE_VALUES = [
  ...Object.values(ExperienceType),
  ...Object.values(ExperienceBucket),
];

export enum ReviewSortBy {
  upvotes = "upvotes",
  downvotes = "downvotes",
  creationTs = "creationTs",
  sentiment = "sentiment",
  experience = "experience",
  depth = "depth",
  reviewScore = "reviewScore",
}

export class ReviewQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 20;

  @IsOptional()
  @IsEnum(ReviewSortBy)
  sortBy?: ReviewSortBy = ReviewSortBy.upvotes;

  @IsOptional()
  @IsEnum(["asc", "desc"])
  sortDir?: "asc" | "desc" = "desc";

  @IsOptional()
  @IsString()
  creationTsFrom?: string;

  @IsOptional()
  @IsString()
  creationTsTo?: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value,
  )
  @IsArray()
  @IsEnum(Sentiment, { each: true })
  sentiments?: Sentiment[];

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value,
  )
  @IsArray()
  @IsEnum(Intent, { each: true })
  intents?: Intent[];

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value,
  )
  @IsArray()
  @IsIn(ALLOWED_EXPERIENCE_VALUES, { each: true })
  experiences?: (ExperienceType | ExperienceBucket)[];

  @IsOptional()
  @IsEnum(Depth)
  depth?: Depth;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value,
  )
  @IsArray()
  @IsString({ each: true })
  useCases?: string[];

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value,
  )
  @IsArray()
  @IsString({ each: true })
  featureLabels?: string[];
}
