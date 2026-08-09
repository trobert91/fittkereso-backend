import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";

export class ContextScoreDto {
  @Expose({ groups: [SerializeGroup.details] }) intentSlug: string;
  @Expose({ groups: [SerializeGroup.details] }) intentLabel: string;
  @Expose({ groups: [SerializeGroup.details] }) recommendationRate: number;
  @Expose({ groups: [SerializeGroup.details] }) reviewCount: number;
}
