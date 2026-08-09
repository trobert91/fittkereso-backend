import { Module } from "@nestjs/common";
import { AiModule } from "@ebike-backend/ai";
import { DeterministicChecksService } from "./deterministic-checks.service";
import { LlmJudgeService } from "./llm-judge.service";
import { ConcurrencyModule } from "../concurrency/concurrency.module";

@Module({
  imports: [AiModule, ConcurrencyModule],
  providers: [DeterministicChecksService, LlmJudgeService],
  exports: [DeterministicChecksService, LlmJudgeService],
})
export class JudgeModule {}
