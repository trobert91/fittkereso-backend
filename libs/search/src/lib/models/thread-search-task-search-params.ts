import { TaskStatus, ThreadPlatform } from "@ebike-backend/database";
import { IsEnum, IsInt, IsOptional, Min } from "class-validator";

export class ThreadSearchTaskSearchParams {
  @IsOptional()
  @IsEnum(TaskStatus, { each: true })
  statuses?: TaskStatus[];

  @IsOptional()
  @IsEnum(ThreadPlatform, { each: true })
  platforms?: ThreadPlatform[];

  @IsOptional()
  categorySlugs?: string[];

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
    "keyword",
    "platform",
    "categorySlug",
    "status",
    "attempts",
    "duplicates",
    "discovered",
    "belowRelevance",
    "scheduledAt",
    "lastRunAt",
    "lockedAt",
    "executionTimeInSec",
    "createdAt",
    "updatedAt",
  ])
  sort?:
    | "keyword"
    | "platform"
    | "categorySlug"
    | "status"
    | "attempts"
    | "duplicates"
    | "discovered"
    | "belowRelevance"
    | "scheduledAt"
    | "lastRunAt"
    | "lockedAt"
    | "executionTimeInSec"
    | "createdAt"
    | "updatedAt";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";
}
