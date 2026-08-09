import { ThreadPlatform } from "@ebike-backend/database";
import { IsEnum, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class ThreadSearchKeywordSearchParams {
  @IsOptional()
  @IsUUID("4", { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsEnum(ThreadPlatform, { each: true })
  platforms?: ThreadPlatform[];

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsEnum(["keyword", "platform", "lastSearchedAt", "createdAt", "updatedAt"])
  sort?: "keyword" | "platform" | "lastSearchedAt" | "createdAt" | "updatedAt";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";
}
