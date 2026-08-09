import { ProductSourceType } from "@ebike-backend/database";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

export class ProductSourceSearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsBoolean()
  schedulingEnabled?: boolean;

  @IsOptional()
  @IsEnum(ProductSourceType, { each: true })
  types?: ProductSourceType[];

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
    "name",
    "type",
    "schedulingEnabled",
    "processingEnabled",
    "priority",
    "maxConcurrent",
    "requestsPerHour",
    "lastRunAt",
    "fullSyncInterval",
    "nextFullSyncAt",
    "lastFullSyncAt",
    "incrementalSyncInterval",
    "nextIncrementalSyncAt",
    "lastIncrementalSyncAt",
    "createdAt",
    "updatedAt",
  ])
  sort?:
    | "name"
    | "type"
    | "schedulingEnabled"
    | "processingEnabled"
    | "priority"
    | "maxConcurrent"
    | "requestsPerHour"
    | "lastRunAt"
    | "fullSyncInterval"
    | "nextFullSyncAt"
    | "lastFullSyncAt"
    | "incrementalSyncInterval"
    | "nextIncrementalSyncAt"
    | "lastIncrementalSyncAt"
    | "createdAt"
    | "updatedAt";

  @IsOptional()
  @IsEnum(["ASC", "DESC"])
  order?: "ASC" | "DESC";
}
