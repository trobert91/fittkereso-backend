import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class OfferSearchParams {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsEnum([
    'price',
    'lastSynced',
    'createdAt',
    'updatedAt',
    'availability',
    'condition',
  ])
  sort?:
    | 'price'
    | 'lastSynced'
    | 'createdAt'
    | 'updatedAt'
    | 'availability'
    | 'condition';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}
