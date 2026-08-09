import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductCategory } from '../models/product-category.entity';

@Injectable()
export class ProductCategoryRepository extends BasePostgresRepository<ProductCategory> {
  constructor(
    @InjectRepository(ProductCategory, 'postgres')
    repository: Repository<ProductCategory>,
  ) {
    super(repository, ProductCategory);
  }

  async findByName(name: string): Promise<ProductCategory | null> {
    return this.repo.findOne({ where: { name } });
  }

  async findBySlug(slug: string): Promise<ProductCategory | null> {
    return this.repo.findOne({ where: { slug } });
  }
}
