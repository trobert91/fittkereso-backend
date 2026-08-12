import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductCategoryRepository,
} from '@fittkereso-backend/database';

@Injectable()
export class ProductCategoryDetailService {
  constructor(private readonly productRepo: ProductCategoryRepository) {}

  public async getById(categoryId: string): Promise<ProductCategory> {
    return this.productRepo.findByIdOrFail(categoryId);
  }
}
