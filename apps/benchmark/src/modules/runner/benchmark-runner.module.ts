import { Module } from '@nestjs/common';
import { ScenarioModule } from '../scenario/scenario.module';
import { InputModule } from '../input/input.module';
import { PhasesModule } from '../phases/phases.module';
import { ExecutionModule } from '../execution/execution.module';
import { JudgeModule } from '../judge/judge.module';
import { CostModule } from '../cost/cost.module';
import { ReportModule } from '../report/report.module';
import { ConcurrencyModule } from '../concurrency/concurrency.module';
import { BenchmarkRunner } from './benchmark-runner.service';

@Module({
  imports: [
    ScenarioModule,
    InputModule,
    PhasesModule,
    ExecutionModule,
    JudgeModule,
    CostModule,
    ReportModule,
    ConcurrencyModule,
  ],
  providers: [BenchmarkRunner],
  exports: [BenchmarkRunner],
})
export class BenchmarkRunnerModule {}
