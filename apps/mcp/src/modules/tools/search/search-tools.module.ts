import { Module } from "@nestjs/common";
import { SearchModule } from "@ebike-backend/search";
import { DatabaseModule } from "@ebike-backend/database";
import { McpModule } from "@rekog/mcp-nest";
import { SearchTools } from "./search.tools";

@Module({
  imports: [
    SearchModule,
    DatabaseModule,
    McpModule.forFeature([SearchTools], "ebike"),
  ],
  providers: [SearchTools],
})
export class SearchToolsModule {}
