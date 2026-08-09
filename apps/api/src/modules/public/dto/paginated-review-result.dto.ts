import { Expose, Type } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { ReviewDto } from "./review.dto";
import { PaginatedResultBase } from "./paginated-result.dto";
import { FilterFieldDto } from "./category.dto";

export class PaginatedReviewResult extends PaginatedResultBase {
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ReviewDto)
  data: ReviewDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => FilterFieldDto)
  aggregations?: FilterFieldDto[];
}
