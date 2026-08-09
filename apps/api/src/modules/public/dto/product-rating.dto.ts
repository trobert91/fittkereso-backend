import { Expose, Type } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";

export class ProductLabelSummaryDto {
  @Expose({ groups: [SerializeGroup.details] }) name: string;
  @Expose({ groups: [SerializeGroup.details] }) mentionCount: number;
  @Expose({ groups: [SerializeGroup.details] }) strongPositiveCount: number;
  @Expose({ groups: [SerializeGroup.details] }) positiveCount: number;
  @Expose({ groups: [SerializeGroup.details] }) neutralCount: number;
  @Expose({ groups: [SerializeGroup.details] }) mixedCount: number;
  @Expose({ groups: [SerializeGroup.details] }) negativeCount: number;
  @Expose({ groups: [SerializeGroup.details] }) strongNegativeCount: number;
  @Expose({ groups: [SerializeGroup.details] }) score: number;
  @Expose({ groups: [SerializeGroup.details] }) headline?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) narrative?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) narrativeGeneratedAt?:
    | string
    | null;
}

export class ProductRatingHighlightDto {
  @Expose({ groups: [SerializeGroup.details] }) text: string;
  @Expose({ groups: [SerializeGroup.details] }) quotes: string[];
}

export class ProductRatingDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  totalReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  strongPositiveReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  positiveReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  negativeReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  strongNegativeReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  neutralReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  mixedReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  handsonReviewCount: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  averageReviewScore?: number | null;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] }) rating?:
    | number
    | null;
  @Expose({ groups: [SerializeGroup.details] }) tldr?: string | null;
  @Expose({ groups: [SerializeGroup.details] }) summary?: string | null;

  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductRatingHighlightDto)
  pros?: ProductRatingHighlightDto[] | null;

  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductRatingHighlightDto)
  cons?: ProductRatingHighlightDto[] | null;
}
