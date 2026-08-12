import { Expose, Type } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class SearchProductDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  displayName: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  brandName?: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  categorySlug?: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  mainImageUrl?: string | null;
}

export class SearchCategoryDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  name: string;
}

export class SearchResultDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => SearchProductDto)
  products: SearchProductDto[];
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => SearchCategoryDto)
  categories: SearchCategoryDto[];
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  total: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  page: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  pageSize: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  totalPages: number;
}

export class AutocompleteProductDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  displayName: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  categorySlug?: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  brandName?: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  mainImageUrl?: string | null;
}

export class AutocompleteCategoryDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  name: string;
}

export class AutocompleteResultDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => AutocompleteProductDto)
  products: AutocompleteProductDto[];
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Type(() => AutocompleteCategoryDto)
  categories: AutocompleteCategoryDto[];
}

export class SearchQueryDto {
  @IsNotEmpty()
  @IsString()
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 20;
}
