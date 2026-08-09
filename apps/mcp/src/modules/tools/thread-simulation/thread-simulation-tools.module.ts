import { Module } from "@nestjs/common";
import { McpModule } from "@rekog/mcp-nest";
import { DatabaseModule } from "@ebike-backend/database";
import { SubtreeBuilderService } from "@ebike-backend/thread-processor";
import { ThreadSimulationTools } from "./thread-simulation.tools";

@Module({
  imports: [
    DatabaseModule,
    McpModule.forFeature([ThreadSimulationTools], "ebike"),
  ],
  providers: [SubtreeBuilderService, ThreadSimulationTools],
})
export class ThreadSimulationToolsModule {}
