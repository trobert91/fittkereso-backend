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

  /**
   * Every source whose configured baseUrl is on this domain.
   *
   * Plural because one webshop legitimately has several — speedbike.hu has a
   * `scraping` source and an `arukereso` one — so anything resolving a source
   * from a URL alone has to decide between them rather than take the first.
   * Returning the set makes that decision the caller's, visibly.
   *
   * Filtered in memory rather than in SQL: `baseUrl` lives inside the config
   * JSONB, whose shape differs per source type.
   */
  async findAllByDomain(domain: string): Promise<ProductSource[]> {
    const sources = await this.repo.find();
    return sources.filter(
      (source) => domainFromUrl(source.config.baseUrl) === domain,
    );
  }
}
