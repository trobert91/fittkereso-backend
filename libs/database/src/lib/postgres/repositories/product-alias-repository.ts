import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductAlias } from '../models/product-alias.entity';

@Injectable()
export class ProductAliasRepository extends BasePostgresRepository<ProductAlias> {
  constructor(
    @InjectRepository(ProductAlias, 'postgres')
    repository: Repository<ProductAlias>,
  ) {
    super(repository, ProductAlias);
  }
}
