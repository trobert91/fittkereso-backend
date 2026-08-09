import { IsObject, IsDefined } from "class-validator";
import { ProductSpecs } from "@ebike-backend/database";

export class ProductSpecUpdateDto {
  @IsObject()
  @IsDefined()
  specs: ProductSpecs;
}
