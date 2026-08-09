import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductReferenceCandidate } from '../models/product-reference-candidate.entity';

@Injectable()
export class ProductReferenceCandidateRepository extends BasePostgresRepository<ProductReferenceCandidate> {
  constructor(
    @InjectRepository(ProductReferenceCandidate, 'postgres')
    repository: Repository<ProductReferenceCandidate>,
  ) {
    super(repository, ProductReferenceCandidate);
  }
}
