import { Module } from "@nestjs/common";
import { AiModule } from "@ebike-backend/ai";
import { ProcessorConfigService } from "@ebike-backend/config";
import { DatabaseModule } from "@ebike-backend/database";
import { DebugModule } from "@ebike-backend/debug";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { ResolutionModule } from "@ebike-backend/resolution";
import { ImageAnalyzerService } from "./services/image-analyzer.service";
import { MediaAnalyzerService } from "./services/media-analyzer.service";
import { ProductReferenceResolutionService } from "./services/product-reference-resolution.service";
import { CommentModerationDecisionService } from "./services/moderation/comment-moderation-decision.service";

/**
 * Lightweight cross-cutting pipeline helpers (media analysis, product-reference
 * resolution, moderation decisions, processor config). Imported by modules that
 * need one of these without pulling in the full extraction pipeline.
 */
@Module({
  imports: [
    AiModule,
    DatabaseModule,
    DebugModule,
    DynamicConfigModule,
    ResolutionModule,
  ],
  providers: [
    ProcessorConfigService,
    ImageAnalyzerService,
    MediaAnalyzerService,
    ProductReferenceResolutionService,
    CommentModerationDecisionService,
  ],
  exports: [
    ProcessorConfigService,
    ImageAnalyzerService,
    MediaAnalyzerService,
    ProductReferenceResolutionService,
    CommentModerationDecisionService,
  ],
})
export class ThreadProcessorSharedModule {}
