import { ProductCategory } from "@ebike-backend/database";
import { Type } from "class-transformer";
import { BasePageResult } from "./base-page-result";

export class CategorySearchResult extends BasePageResult<ProductCategory> {
  @Type(() => ProductCategory)
  override items?: ProductCategory[];
}
