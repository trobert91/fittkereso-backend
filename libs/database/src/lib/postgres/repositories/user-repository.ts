import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { User } from '../models/user.entity';

@Injectable()
export class UserRepository extends BasePostgresRepository<User> {
  constructor(
    @InjectRepository(User, 'postgres')
    repository: Repository<User>,
  ) {
    super(repository, User);
  }

  /** Resolves the local row for a verified Supabase token. */
  async findByAuthUserId(
    authUserId: string,
    transaction?: EntityManager,
  ): Promise<User | null> {
    const where = { [nameOf<User>('authUserId')]: authUserId };

    return transaction
      ? transaction.findOneBy(User, where)
      : this.repo.findOneBy(where);
  }

  /** Callers must lower-case the address first; emails are stored lower-cased. */
  async findByEmail(
    email: string,
    transaction?: EntityManager,
  ): Promise<User | null> {
    const where = { [nameOf<User>('email')]: email };

    return transaction
      ? transaction.findOneBy(User, where)
      : this.repo.findOneBy(where);
  }
}
