import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductSourceVersion } from '../models/product-source-version.entity';
import { nameOf } from '@fittkereso-backend/utils';

/**
 * The append-only config history.
 *
 * Reads and one insert, and no update or delete — a revision is the record of
 * which config was in force when, and a record that can be rewritten answers
 * no question. Changing a source is writing the next version; putting an old
 * one back is writing the next version too.
 *
 * `BasePostgresRepository` does expose generic save/delete through `repo`, so
 * this is a convention rather than a database grant. Every caller goes through
 * ProductSourceVersionService, which only ever inserts.
 */
@Injectable()
export class ProductSourceVersionRepository extends BasePostgresRepository<ProductSourceVersion> {
  constructor(
    @InjectRepository(ProductSourceVersion, 'postgres')
    repository: Repository<ProductSourceVersion>,
  ) {
    super(repository, ProductSourceVersion);
  }

  /**
   * The version in force: the highest number, not the newest timestamp.
   *
   * The number is the authority. Two rows written in the same transaction
   * share an instant, so ordering by time would make "the current one"
   * whichever the planner happened to return.
   */
  public async findCurrent(
    sourceId: string,
    transaction?: EntityManager,
  ): Promise<ProductSourceVersion | null> {
    const repo = transaction
      ? transaction.getRepository(ProductSourceVersion)
      : this.repo;

    return repo.findOne({
      where: { source: { id: sourceId } },
      order: { version: 'DESC' },
    });
  }

  /** One numbered revision of one source. Scoped to the source so a number belonging to another reads as absent. */
  public async findByVersion(
    sourceId: string,
    version: number,
  ): Promise<ProductSourceVersion | null> {
    return this.repo.findOne({
      where: { source: { id: sourceId }, version },
      relations: { actorUser: true },
    });
  }

  /**
   * The next number to write.
   *
   * Read inside the same transaction as the insert that uses it, and backed by
   * the (source, version) unique constraint rather than by this read: two
   * saves racing here both see the same maximum, and the constraint is what
   * turns the second into a violation to retry.
   */
  public async nextVersionNumber(
    sourceId: string,
    transaction: EntityManager,
  ): Promise<number> {
    const row = await transaction
      .getRepository(ProductSourceVersion)
      .createQueryBuilder('version')
      .select(
        `COALESCE(MAX(version.${nameOf<ProductSourceVersion>('version')}), 0)`,
        'max',
      )
      .where(`version.sourceId = :sourceId`, { sourceId })
      .getRawOne<{ max: string }>();

    return Number(row?.max ?? 0) + 1;
  }

  /** The history, newest first. */
  public async listForSource(
    sourceId: string,
    options: { skip?: number; take?: number } = {},
  ): Promise<[ProductSourceVersion[], number]> {
    return this.repo.findAndCount({
      where: { source: { id: sourceId } },
      relations: { actorUser: true },
      order: { version: 'DESC' },
      skip: options.skip ?? 0,
      take: options.take ?? 25,
    });
  }
}
