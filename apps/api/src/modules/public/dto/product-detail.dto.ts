import { Expose, Transform, Type } from "class-transformer";
import { SerializeGroup, transfromExposeAll } from "@ebike-backend/utils";
import { BrandDto } from "./brand.dto";
import { MainImageDto } from "./main-image.dto";
import { ProductLabelSummaryDto, ProductRatingDto } from "./product-rating.dto";
import { ContextScoreDto } from "./context-score.dto";
import type { OrderedSpec, ProductSpecs } from "@ebike-backend/database";

export class ProductImageDto {
  @Expose({ groups: [SerializeGroup.details] }) url: string;
  @Expose({ groups: [SerializeGroup.details] }) order: number;
}

export class ShopLinkDto {
  @Expose({ groups: [SerializeGroup.details] }) url: string;
  @Expose({ groups: [SerializeGroup.details] }) platform: string | null;
}

export class ProductDetailDto {
  @Expose({ groups: [SerializeGroup.details] }) id: string;
  @Expose({ groups: [SerializeGroup.details] }) slug: string;
  @Expose({ groups: [SerializeGroup.details] }) displayName: string;
  @Expose({ groups: [SerializeGroup.details] }) model: string;
  @Expose({ groups: [SerializeGroup.details] }) releaseYear?: number | null;
  @Expose({ groups: [SerializeGroup.details] }) description?: string | null;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => BrandDto)
  brand: BrandDto;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => MainImageDto)
  mainImage?: MainImageDto | null;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductRatingDto)
  rating?: ProductRatingDto | null;
  @Expose({ groups: [SerializeGroup.details] })
  @Transform(transfromExposeAll())
  specs?: ProductSpecs;
  @Expose({ groups: [SerializeGroup.details] })
  @Transform(transfromExposeAll())
  orderedSpecs?: OrderedSpec[];
  @Expose({ groups: [SerializeGroup.details] }) aliases?: string[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductImageDto)
  images: ProductImageDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ShopLinkDto)
  shopLinks: ShopLinkDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ContextScoreDto)
  contextScores: ContextScoreDto[];
  @Expose({ groups: [SerializeGroup.details] }) categorySlug: string;
  @Expose({ groups: [SerializeGroup.details] }) categoryName: string;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductLabelSummaryDto)
  featureSummary?: ProductLabelSummaryDto[] | null;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductLabelSummaryDto)
  issueSummary?: ProductLabelSummaryDto[] | null;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => ProductLabelSummaryDto)
  useCaseSummary?: ProductLabelSummaryDto[] | null;
  @Expose({ groups: [SerializeGroup.details] }) availableUseCases?:
    | string[]
    | null;
  @Expose({ groups: [SerializeGroup.details] }) availableFeatures?:
    | string[]
    | null;
}
