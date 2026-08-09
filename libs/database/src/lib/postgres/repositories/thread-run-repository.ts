import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ThreadRun } from '../models/thread-run.entity';

@Injectable()
export class ThreadRunRepository extends BasePostgresRepository<ThreadRun> {
  constructor(
    @InjectRepository(ThreadRun, 'postgres')
    repository: Repository<ThreadRun>,
  ) {
    super(repository, ThreadRun);
  }
}
