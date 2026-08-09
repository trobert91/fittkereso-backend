import { ClassConstructor } from 'class-transformer';
import {
  EntityManager,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  Repository,
  SaveOptions,
} from 'typeorm';
import { BasePostgresEntity } from '../models/base-postgres-entity';
import { isEmpty } from 'lodash';

export abstract class BasePostgresRepository<T extends BasePostgresEntity> {
  constructor(
    public readonly repo: Repository<T>,
    protected classConstructor: ClassConstructor<T>,
  ) {}

  async findById(id: string, transaction?: EntityManager): Promise<T | null> {
    if (transaction) {
      return transaction.findOneBy(this.classConstructor, {
        id,
      } as FindOptionsWhere<T>);
    } else {
      return this.repo.findOneBy({
        id,
      } as FindOptionsWhere<T>);
    }
  }

  async findByIdOrFail(id: string, transaction?: EntityManager): Promise<T> {
    if (transaction) {
      return transaction.findOneByOrFail(this.classConstructor, {
        id,
      } as FindOptionsWhere<T>);
    } else {
      return this.repo.findOneByOrFail({
        id,
      } as FindOptionsWhere<T>);
    }
  }

  async findAllById(ids: string[], transaction?: EntityManager): Promise<T[]> {
    if (isEmpty(ids)) {
      return [];
    }

    const queryBuilder = transaction
      ? transaction.createQueryBuilder()
      : this.repo.createQueryBuilder();

    return queryBuilder.where('id IN (:...ids)', { ids }).getMany() as Promise<
      T[]
    >;
  }

  async getAll(options?: FindManyOptions): Promise<T[]> {
    const entities = await this.repo.find(options);

    return entities;
  }

  async deleteById(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (isEmpty(ids)) {
      return;
    }

    await this.repo.delete(ids);
  }

  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    const entity = await this.repo.findOne(options);
    if (!entity) {
      return null;
    }

    return entity;
  }

  async findOneOrFail(
    options: FindOneOptions<T>,
    transaction?: EntityManager,
  ): Promise<T> {
    if (transaction) {
      return transaction.findOneOrFail(this.classConstructor, options);
    } else {
      return this.repo.findOneOrFail(options);
    }
  }

  async find(options: FindManyOptions<T>): Promise<T[]> {
    const entities = await this.repo.find(options);

    return entities;
  }

  async findAndCount(options: FindManyOptions<T>): Promise<[T[], number]> {
    const [entities, count] = await this.repo.findAndCount(options);

    return [entities, count];
  }

  async save(
    entity: T,
    options?: SaveOptions,
    transaction?: EntityManager,
  ): Promise<T> {
    if (transaction) {
      return transaction.save(entity, options);
    } else {
      return this.repo.save(entity, options);
    }
  }

  async saveAll(
    entities: T[],
    options?: SaveOptions,
    transaction?: EntityManager,
  ): Promise<T[]> {
    if (transaction) {
      return transaction.save(entities, options);
    } else {
      return this.repo.save(entities, options);
    }
  }
}
