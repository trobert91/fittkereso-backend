import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ReviewLabel } from '../models';

@Injectable()
export class ReviewLabelRepository extends BasePostgresRepository<ReviewLabel> {
  constructor(
    @InjectRepository(ReviewLabel, 'postgres')
    repository: Repository<ReviewLabel>,
  ) {
    super(repository, ReviewLabel);
  }
}
