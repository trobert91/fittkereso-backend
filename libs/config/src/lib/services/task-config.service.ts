/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TaskConfigService {
  constructor(private configService: ConfigService) {}

  get maxAttempts(): number {
    return this.configService.get<number>('task.max_attempts')!;
  }

  get processCommentsInParallel(): boolean {
    return this.configService.get<boolean>('task.process_comments_parallel')!;
  }
}
