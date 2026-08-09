import { IsNotEmpty, IsString } from 'class-validator';

export class ProductAliasDto {
  @IsString()
  @IsNotEmpty()
  alias: string;
}
