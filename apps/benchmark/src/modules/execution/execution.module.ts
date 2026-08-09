import { Module } from '@nestjs/common';
import { JudgeModule } from '../judge/judge.module';
import { CandidateExecutor } from './candidate-executor.service';

@Module({
  imports: [JudgeModule],
  providers: [CandidateExecutor],
  exports: [CandidateExecutor],
})
export class ExecutionModule {}
