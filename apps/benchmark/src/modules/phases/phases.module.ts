import { Module } from "@nestjs/common";
import { AiModule } from "@ebike-backend/ai";
import {
  PromptAssemblyService,
  ValidationSubtreeRenderer,
} from "@ebike-backend/thread-processor";
import { ProductSpecContextService } from "@ebike-backend/product";
import { IdentificationPhaseRunner } from "./identification-phase.runner";
import { ExtractionPhaseRunner } from "./extraction-phase.runner";
import { LabelingPhaseRunner } from "./labeling-phase.runner";
import { ValidationPhaseRunner } from "./validation-phase.runner";
import { ConcurrencyModule } from "../concurrency/concurrency.module";

@Module({
  imports: [AiModule, ConcurrencyModule],
  providers: [
    // Direct providers for the prompt-assembly chain. We don't import
    // ThreadProcessorModule because it pulls in the rest of the pipeline
    // (resolution, validation, moderation) which the benchmark does not need.
    ProductSpecContextService,
    PromptAssemblyService,
    ValidationSubtreeRenderer,
    IdentificationPhaseRunner,
    ExtractionPhaseRunner,
    LabelingPhaseRunner,
    ValidationPhaseRunner,
  ],
  exports: [
    IdentificationPhaseRunner,
    ExtractionPhaseRunner,
    LabelingPhaseRunner,
    ValidationPhaseRunner,
    PromptAssemblyService,
    ValidationSubtreeRenderer,
  ],
})
export class PhasesModule {}
