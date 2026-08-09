import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { Review } from '../models';

@Injectable()
export class ReviewRepository extends BasePostgresRepository<Review> {
  constructor(
    @InjectRepository(Review, 'postgres')
    repository: Repository<Review>,
  ) {
    super(repository, Review);
  }
}
