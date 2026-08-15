import { IsNotEmpty, IsString } from 'class-validator';

export class SellerCreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
