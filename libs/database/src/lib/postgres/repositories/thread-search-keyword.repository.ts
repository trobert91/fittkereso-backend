import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ThreadSearchKeyword } from '../models/thread-search-keyword.entity';

@Injectable()
export class ThreadSearchKeywordRepository extends BasePostgresRepository<ThreadSearchKeyword> {
  constructor(
    @InjectRepository(ThreadSearchKeyword, 'postgres')
    repository: Repository<ThreadSearchKeyword>,
  ) {
    super(repository, ThreadSearchKeyword);
  }
}
