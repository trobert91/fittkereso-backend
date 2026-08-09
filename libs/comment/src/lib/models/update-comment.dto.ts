import { IsArray, IsOptional, ValidateNested } from 'class-validator';
import { UpdateProductReferenceDto } from './update-product-reference.dto';
import { Type } from 'class-transformer';

export class UpdateCommentDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateProductReferenceDto)
  productReferences: UpdateProductReferenceDto[];
}
