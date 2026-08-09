import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ThreadProductCategory } from '../models/thread-product-category.entity';

@Injectable()
export class ThreadProductCategoryRepository extends BasePostgresRepository<ThreadProductCategory> {
  constructor(
    @InjectRepository(ThreadProductCategory, 'postgres')
    repository: Repository<ThreadProductCategory>,
  ) {
    super(repository, ThreadProductCategory);
  }
}
