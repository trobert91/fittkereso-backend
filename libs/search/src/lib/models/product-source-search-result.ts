import { ProductSource, ProductSourceType } from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class ProductSourceSearchResult extends BasePageResult<ProductSource> {
  searchTerm?: string;

  schedulingEnabled?: boolean;

  types?: ProductSourceType[];
}
