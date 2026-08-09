import { Module } from "@nestjs/common";
import { ReviewUpdaterService } from "./services/review-updater.service";
import { DatabaseModule } from "@ebike-backend/database";
import { DebugModule } from "@ebike-backend/debug";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { ReviewEvaluatorService } from "./services/review-evaluator.service";

@Module({
  imports: [DatabaseModule, DebugModule, DynamicConfigModule],
  providers: [ReviewEvaluatorService, ReviewUpdaterService],
  exports: [ReviewUpdaterService],
})
export class ReviewCreatorModule {}
