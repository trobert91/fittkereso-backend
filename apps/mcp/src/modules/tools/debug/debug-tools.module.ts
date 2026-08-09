import { Module } from "@nestjs/common";
import { DebugModule } from "@ebike-backend/debug";
import { DatabaseModule } from "@ebike-backend/database";
import { McpModule } from "@rekog/mcp-nest";
import { DebugTraceTools } from "./debug-trace.tools";
import { CostAnalysisTools } from "./cost-analysis.tools";
import { ComparisonTools } from "./comparison.tools";

@Module({
  imports: [
    DebugModule,
    DatabaseModule,
    McpModule.forFeature(
      [DebugTraceTools, CostAnalysisTools, ComparisonTools],
      "ebike",
    ),
  ],
  providers: [DebugTraceTools, CostAnalysisTools, ComparisonTools],
})
export class DebugToolsModule {}
