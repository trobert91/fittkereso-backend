import { Expose, Type } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { ProductListDto } from "./product-list.dto";
import {
  FilterFieldDto,
  FilterOptionDto,
  NumericRangeDto,
} from "./category.dto";

export abstract class PaginatedResultBase {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  total: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  page: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  pageSize: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  totalPages: number;
}

export class PaginatedProductResult extends PaginatedResultBase {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => ProductListDto)
  data: ProductListDto[];
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => FilterFieldDto)
  aggregations?: FilterFieldDto[];
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => FilterOptionDto)
  brands?: FilterOptionDto[];
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => NumericRangeDto)
  scoreRange?: NumericRangeDto;
}
