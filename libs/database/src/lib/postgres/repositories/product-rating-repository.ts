import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductRating } from '../models';

@Injectable()
export class ProductRatingRepository extends BasePostgresRepository<ProductRating> {
  constructor(
    @InjectRepository(ProductRating, 'postgres')
    repository: Repository<ProductRating>,
  ) {
    super(repository, ProductRating);
  }
}
