import { Module } from "@nestjs/common";
import { AiModule } from "@ebike-backend/ai";
import { DatabaseModule } from "@ebike-backend/database";
import { DebugModule } from "@ebike-backend/debug";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { MetricsModule } from "@ebike-backend/metrics";
import { ProductModule } from "@ebike-backend/product";
import { ResolutionModule } from "@ebike-backend/resolution";
import { RelevanceModule } from "@ebike-backend/relevance";
import { ThreadModule } from "@ebike-backend/thread";
import { ThreadProcessorSharedModule } from "./thread-processor-shared.module";
import { IssueDetectorsModule } from "./services/validation/detectors/detectors.module";
import { ThreadExtractionService } from "./services/thread-extraction.service";
import { OPSummarizerService } from "./services/op-summarizer.service";
import { ProductRegistryService } from "./services/product-registry.service";
import { RegistryCheatSheetRenderer } from "./services/registry-cheat-sheet-renderer.service";
import { PromptAssemblyService } from "./services/prompt-assembly.service";
import { QuoteLabelingService } from "./services/quote-labeling.service";
import { ResolutionInputEnricher } from "./services/resolution-input-enricher.service";
import { SubtreeBuilderService } from "./services/subtree-builder.service";
import { SubtreeContextBuilderService } from "./services/subtree-context-builder.service";
import { SubtreeExtractionService } from "./services/subtree-extraction.service";
import { ProductDiscoveryService } from "./services/product-discovery.service";
import { CommentIdentificationService } from "./services/comment-identification.service";
import { DiscoveredProductEnricher } from "./services/discovered-product-enricher.service";
import { DistinctProductResolver } from "./services/distinct-product-resolver.service";
import { SeededReferenceFactory } from "./services/seeded-reference-factory.service";
import { RegistryPreloadService } from "./services/registry-preload.service";
import { WideIdentificationPassService } from "./services/wide-identification-pass.service";
import { SubtreeProcessorService } from "./services/subtree-processor.service";
import { ProductResolutionOrchestratorService } from "./services/product-resolution-orchestrator.service";
import { ThreadRunDetailsBuilderService } from "./services/thread-run-details-builder.service";
import { SubtreeIssueResolutionService } from "./services/validation/subtree-issue-resolution.service";
import { SubtreeLlmIssueResolutionService } from "./services/validation/subtree-llm-issue-resolution.service";
import { SubtreeValidationStageService } from "./services/validation/subtree-validation-stage.service";
import { ValidationSubtreeRenderer } from "./services/validation/validation-subtree-renderer";
import { SubtreeModerationService } from "./services/moderation/subtree-moderation.service";

@Module({
  imports: [
    ThreadProcessorSharedModule,
    IssueDetectorsModule,
    AiModule,
    DatabaseModule,
    DebugModule,
    DynamicConfigModule,
    MetricsModule,
    ProductModule,
    ResolutionModule,
    RelevanceModule,
    ThreadModule,
  ],
  providers: [
    SubtreeContextBuilderService,
    SubtreeBuilderService,
    ProductRegistryService,
    RegistryCheatSheetRenderer,
    OPSummarizerService,
    PromptAssemblyService,
    SubtreeExtractionService,
    QuoteLabelingService,
    ProductDiscoveryService,
    CommentIdentificationService,
    DiscoveredProductEnricher,
    DistinctProductResolver,
    SeededReferenceFactory,
    RegistryPreloadService,
    WideIdentificationPassService,
    ResolutionInputEnricher,
    ProductResolutionOrchestratorService,
    SubtreeIssueResolutionService,
    SubtreeLlmIssueResolutionService,
    SubtreeValidationStageService,
    ValidationSubtreeRenderer,
    SubtreeModerationService,
    SubtreeProcessorService,
    ThreadRunDetailsBuilderService,
    ThreadExtractionService,
  ],
  exports: [ThreadExtractionService, ThreadProcessorSharedModule],
})
export class ThreadProcessorModule {}
