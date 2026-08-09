import { Injectable } from "@nestjs/common";
import { Brand, BrandRepository } from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class BrandDetailService {
  constructor(private readonly brandRepo: BrandRepository) {}

  public async getById(brandId: string): Promise<Brand> {
    return this.brandRepo.findOneOrFail({
      where: { id: brandId },
      relations: [nameOf<Brand>("aliases")],
    });
  }
}
