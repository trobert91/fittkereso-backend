import { ProductDuplicate } from "@ebike-backend/database";
import { SerializeGroup } from "@ebike-backend/utils";
import { Expose, Type } from "class-transformer";
import { BasePageResult } from "./base-page-result";

export class ProductDuplicateSearchResult extends BasePageResult<ProductDuplicate> {
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Type(() => ProductDuplicate)
  override items?: ProductDuplicate[];
}
