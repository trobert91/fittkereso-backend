import { IsObject, IsDefined } from 'class-validator';
import { ProductSpecs } from '@fittkereso-backend/database';

export class ProductSpecUpdateDto {
  @IsObject()
  @IsDefined()
  specs: ProductSpecs;
}
