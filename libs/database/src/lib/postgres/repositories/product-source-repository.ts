import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { domainFromUrl } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductSource } from '../models/product-source.entity';

@Injectable()
export class ProductSourceRepository extends BasePostgresRepository<ProductSource> {
  constructor(
    @InjectRepository(ProductSource, 'postgres')
    repository: Repository<ProductSource>,
  ) {
    super(repository, ProductSource);
  }

  async findByDomain(domain: string): Promise<ProductSource | null> {
    const sources = await this.repo.find();
    return (
      sources.find(
        (source) => domainFromUrl(source.config.baseUrl) === domain,
      ) ?? null
    );
  }
}
