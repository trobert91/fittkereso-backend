import { Module } from '@nestjs/common';
import { DebugToolsModule } from './debug/debug-tools.module';
import { SearchToolsModule } from './search/search-tools.module';
import { EntityToolsModule } from './entity/entity-tools.module';
import { CategoryToolsModule } from './category/category-tools.module';
import { ThreadSearchToolsModule } from './thread-search/thread-search-tools.module';
import { AiChatToolsModule } from './ai-chat/ai-chat-tools.module';
import { ThreadSimulationToolsModule } from './thread-simulation/thread-simulation-tools.module';

@Module({
  imports: [
    DebugToolsModule,
    SearchToolsModule,
    EntityToolsModule,
    CategoryToolsModule,
    ThreadSearchToolsModule,
    AiChatToolsModule,
    ThreadSimulationToolsModule,
  ],
})
export class ToolsModule {}
