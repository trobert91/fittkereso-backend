import { Injectable } from '@nestjs/common';
import { Brand, BrandRepository } from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class BrandDetailService {
  constructor(private readonly brandRepo: BrandRepository) {}

  public async getById(brandId: string): Promise<Brand> {
    return this.brandRepo.findOneOrFail({
      where: { id: brandId },
      relations: [nameOf<Brand>('aliases')],
    });
  }
}
