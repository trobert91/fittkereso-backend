import { Expose, Transform, Type } from 'class-transformer';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import {
  ProductCategory,
  ProductCategoryConfig,
} from '@fittkereso-backend/database';

export class CategoryWithConfigDto {
  @Expose()
  @Type(() => ProductCategory)
  category: ProductCategory;

  @Expose()
  @Transform(transfromExposeAll())
  config?: ProductCategoryConfig;
}

export class CategoryWithConfigSearchResultDto {
  @Expose({ groups: [SerializeGroup.list] })
  page?: number;

  @Expose({ groups: [SerializeGroup.list] })
  pageSize?: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalItems?: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalPages?: number;

  @Expose({ groups: [SerializeGroup.list] })
  @Type(() => CategoryWithConfigDto)
  items?: CategoryWithConfigDto[];

  @Expose({ groups: [SerializeGroup.list] })
  sort?: string;

  @Expose({ groups: [SerializeGroup.list] })
  order?: 'ASC' | 'DESC';
}
