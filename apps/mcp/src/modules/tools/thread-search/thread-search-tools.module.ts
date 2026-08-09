import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { DebugModule } from "@ebike-backend/debug";
import { KeywordStatsService } from "@ebike-backend/thread-search";
import { McpModule } from "@rekog/mcp-nest";
import { ThreadSearchTools } from "./thread-search.tools";

@Module({
  imports: [
    DatabaseModule,
    DebugModule,
    McpModule.forFeature([ThreadSearchTools], "ebike"),
  ],
  providers: [KeywordStatsService, ThreadSearchTools],
})
export class ThreadSearchToolsModule {}
