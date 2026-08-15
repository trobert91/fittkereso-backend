import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { Seller } from '../models/seller.entity';

@Injectable()
export class SellerRepository extends BasePostgresRepository<Seller> {
  constructor(
    @InjectRepository(Seller, 'postgres')
    repository: Repository<Seller>,
  ) {
    super(repository, Seller);
  }
}
