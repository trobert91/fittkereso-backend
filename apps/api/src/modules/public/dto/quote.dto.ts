import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";

export class QuoteDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  productSlug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  productName: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  categorySlug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  brandName: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  quote: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  upvotes: number;
}
