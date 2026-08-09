import { ThreadRunStatus } from "@ebike-backend/database";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
} from "class-validator";

export class ThreadRunSearchParams {
  @IsOptional()
  @IsEnum(ThreadRunStatus, { each: true })
  statuses?: ThreadRunStatus[];

  @IsOptional()
  @IsUUID()
  threadId?: string;

  @IsOptional()
  @IsDateString()
  startedAtFrom?: string;

  @IsOptional()
  @IsDateString()
  startedAtTo?: string;

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
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
    "totalCostUsd",
    "createdAt",
    "updatedAt",
  ])
  sort?:
    | "status"
    | "startedAt"
    | "completedAt"
    | "durationMs"
    | "totalCostUsd"
    | "createdAt"
    | "updatedAt";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";
}
