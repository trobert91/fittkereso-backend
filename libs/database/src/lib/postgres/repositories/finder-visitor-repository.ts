import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { FinderVisitor } from '../models/finder-visitor.entity';

@Injectable()
export class FinderVisitorRepository extends BasePostgresRepository<FinderVisitor> {
  constructor(
    @InjectRepository(FinderVisitor, 'postgres')
    repository: Repository<FinderVisitor>,
  ) {
    super(repository, FinderVisitor);
  }

  /**
   * Deletes every visitor last seen before `cutoff`; their saved results go
   * with them (cascade). Returns how many visitors were deleted.
   */
  async deleteNotSeenSince(cutoff: Date): Promise<number> {
    const result = await this.repo.delete({ lastSeenAt: LessThan(cutoff) });
    return result.affected ?? 0;
  }
}
