import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { PriceHistory } from '../models/price-history.entity';

@Injectable()
export class PriceHistoryRepository extends BasePostgresRepository<PriceHistory> {
  constructor(
    @InjectRepository(PriceHistory, 'postgres')
    repository: Repository<PriceHistory>,
  ) {
    super(repository, PriceHistory);
  }
}
