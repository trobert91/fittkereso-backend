import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { Brand } from '../models/brand.entity';
import { WithSimilarity } from '../models/with-similarity';

@Injectable()
export class BrandRepository extends BasePostgresRepository<Brand> {
  constructor(
    @InjectRepository(Brand, 'postgres')
    repository: Repository<Brand>,
  ) {
    super(repository, Brand);
  }

  async findWithSimilarity(
    name: string,
    minSimilarity: number,
    limit: number,
  ): Promise<WithSimilarity<Brand>[]> {
    const { entities, raw } = await this.repo
      .createQueryBuilder('brand')
      .addSelect('similarity(brand.name, :name)', 'similarity')
      .where('similarity(brand.name, :name) >= :minSimilarity', {
        name,
        minSimilarity,
      })
      .orderBy('similarity(brand.name, :name)', 'DESC')
      .limit(limit)
      .getRawAndEntities();

    return entities.map((entity, idx) => ({
      entity,
      similarity: parseFloat(raw[idx].similarity),
    }));
  }
}
