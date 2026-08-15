import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { BillingInfo } from '../models/billing-info.entity';

@Injectable()
export class BillingInfoRepository extends BasePostgresRepository<BillingInfo> {
  constructor(
    @InjectRepository(BillingInfo, 'postgres')
    repository: Repository<BillingInfo>,
  ) {
    super(repository, BillingInfo);
  }
}
