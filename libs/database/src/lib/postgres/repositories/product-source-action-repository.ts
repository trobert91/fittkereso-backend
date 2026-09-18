import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductSourceAction } from '../models/product-source-action.entity';

/**
 * The append-only product source audit trail.
 *
 * Insert and reads only, for the reason the version repository gives: a
 * correction is a new row, never an edit to an old one.
 */
@Injectable()
export class ProductSourceActionRepository extends BasePostgresRepository<ProductSourceAction> {
  constructor(
    @InjectRepository(ProductSourceAction, 'postgres')
    repository: Repository<ProductSourceAction>,
  ) {
    super(repository, ProductSourceAction);
  }

  /**
   * Records one entry.
   *
   * Takes an optional transaction so an action can be written in the same
   * transaction as the change it describes — a version and the row saying it
   * was created must not be able to exist without each other.
   */
  public async record(
    action: ProductSourceAction,
    transaction?: EntityManager,
  ): Promise<ProductSourceAction> {
    const repo = transaction
      ? transaction.getRepository(ProductSourceAction)
      : this.repo;

    return repo.save(action);
  }

  /** The timeline, newest first, ordered by when things happened rather than when they were written down. */
  public async listForSource(
    sourceId: string,
    options: { skip?: number; take?: number; types?: string[] } = {},
  ): Promise<[ProductSourceAction[], number]> {
    const query = this.repo
      .createQueryBuilder('action')
      .leftJoinAndSelect('action.actorUser', 'actorUser')
      .where('action.sourceId = :sourceId', { sourceId });

    if (options.types?.length) {
      query.andWhere('action.type IN (:...types)', { types: options.types });
    }

    return query
      // The id breaks the tie: rows written in one transaction share an
      // instant, and without it "newest" would be whichever the planner
      // returned, which can differ between two reads of the same data.
      .orderBy('action.occurredAt', 'DESC')
      .addOrderBy('action.id', 'DESC')
      .skip(options.skip ?? 0)
      .take(options.take ?? 25)
      .getManyAndCount();
  }
}
