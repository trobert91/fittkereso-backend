import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { UserComment } from '../models/user-comment.entity';

@Injectable()
export class UserCommentRepository extends BasePostgresRepository<UserComment> {
  constructor(
    @InjectRepository(UserComment, 'postgres')
    repository: Repository<UserComment>,
  ) {
    super(repository, UserComment);
  }
}
