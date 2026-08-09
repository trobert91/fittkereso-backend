import { ThreadPlatform, ThreadStatus } from "@ebike-backend/database";
import {
  IsString,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
  IsBoolean,
} from "class-validator";

export class ThreadSearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsEnum(ThreadPlatform)
  source?: ThreadPlatform;

  @IsOptional()
  @IsString()
  topic?: string;

  @IsOptional()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsEnum(ThreadStatus, { each: true })
  statuses?: ThreadStatus[];

  @IsOptional()
  @IsBoolean()
  filterByUncategorized?: boolean;

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
    "title",
    "topic",
    "relevance",
    "relevanceEstimation",
    "commentCount",
    "status",
    "lastSynced",
    "createdAt",
    "updatedAt",
  ])
  sort?:
    | "title"
    | "topic"
    | "relevance"
    | "relevanceEstimation"
    | "commentCount"
    | "status"
    | "lastSynced"
    | "createdAt"
    | "updatedAt";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";
}
