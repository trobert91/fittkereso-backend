import { Module } from '@nestjs/common';
import { LlmCallGate } from './llm-call-gate.service';

@Module({
  providers: [LlmCallGate],
  exports: [LlmCallGate],
})
export class ConcurrencyModule {}
