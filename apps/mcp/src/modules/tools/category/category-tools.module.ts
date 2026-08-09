import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { McpModule } from "@rekog/mcp-nest";
import { CategoryTools } from "./category.tools";

@Module({
  imports: [DatabaseModule, McpModule.forFeature([CategoryTools], "ebike")],
  providers: [CategoryTools],
})
export class CategoryToolsModule {}
