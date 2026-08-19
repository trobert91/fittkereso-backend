import { IsNotEmpty, IsString } from 'class-validator';

export class SellerProductSourceCreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
