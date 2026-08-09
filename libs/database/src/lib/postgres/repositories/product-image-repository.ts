import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductImage } from '../models';

@Injectable()
export class ProductImageRepository extends BasePostgresRepository<ProductImage> {
  constructor(
    @InjectRepository(ProductImage, 'postgres')
    repository: Repository<ProductImage>,
  ) {
    super(repository, ProductImage);
  }
}
