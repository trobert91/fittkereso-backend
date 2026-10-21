import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { OfferClick } from '../models/offer-click.entity';

@Injectable()
export class OfferClickRepository extends BasePostgresRepository<OfferClick> {
  constructor(
    @InjectRepository(OfferClick, 'postgres')
    repository: Repository<OfferClick>,
  ) {
    super(repository, OfferClick);
  }

  /**
   * Erases the visitor key of every click older than `cutoff`. The rows stay:
   * without the key they are tied to no one. Returns how many were erased.
   */
  async eraseVisitorKeysBefore(cutoff: Date): Promise<number> {
    const result = await this.repo.update(
      { visitorKey: Not(IsNull()), createdAt: LessThan(cutoff) },
      { visitorKey: null },
    );
    return result.affected ?? 0;
  }
}
