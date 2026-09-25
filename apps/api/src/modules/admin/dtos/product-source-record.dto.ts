import { Expose, Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ProductSourceRecordRow } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { ProductSourceHistoryQueryDto } from './product-source-history.dto';

/** A source's listings: attached or not, matching a text, paged. */
export class ProductSourceRecordQueryDto extends ProductSourceHistoryQueryDto {
  // A query string carries "true"/"false", not booleans.
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  attached?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Decorated like ProductSourceVersionListDto, for the same reason. */
export class ProductSourceRecordListDto {
  @Expose({ groups: [SerializeGroup.list] })
  items: ProductSourceRecordRow[];

  @Expose({ groups: [SerializeGroup.list] })
  total: number;
}
