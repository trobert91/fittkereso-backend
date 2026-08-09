import { Expose, Transform, Type } from "class-transformer";
import { SerializeGroup, transfromExposeAll } from "@ebike-backend/utils";
import { BrandDto } from "./brand.dto";
import { CategoryListDto } from "./category.dto";
import { MainImageDto } from "./main-image.dto";
import { ProductRatingDto } from "./product-rating.dto";
import type { OrderedSpec } from "@ebike-backend/database";

export class ProductListDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] }) id: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  displayName: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  model: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  releaseYear?: number | null;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => BrandDto)
  brand: BrandDto;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => CategoryListDto)
  category?: CategoryListDto;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => MainImageDto)
  mainImage?: MainImageDto | null;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => ProductRatingDto)
  rating?: ProductRatingDto | null;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Transform(transfromExposeAll())
  orderedSpecs?: OrderedSpec[];
}
