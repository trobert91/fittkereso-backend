import { Module } from "@nestjs/common";
import { ResolutionTestController } from "./resolution-test/resolution-test.controller";
import { CategoryTestController } from "./category-test/category-test.controller";
import { SearchAgentTestController } from "./search-agent-test/search-agent-test.controller";
import { ThreadRelevanceTestController } from "./thread-relevance-test/thread-relevance-test.controller";
import { ResolutionModule } from "@ebike-backend/resolution";
import { ThreadModule } from "@ebike-backend/thread";
import { DatabaseModule } from "@ebike-backend/database";
import { RelevanceModule } from "@ebike-backend/relevance";
import { AuthModule } from "@ebike-backend/auth";

@Module({
  imports: [
    DatabaseModule,
    ResolutionModule,
    ThreadModule,
    RelevanceModule,
    AuthModule,
  ],
  controllers: [
    ResolutionTestController,
    CategoryTestController,
    SearchAgentTestController,
    ThreadRelevanceTestController,
  ],
})
export class TestModule {}
