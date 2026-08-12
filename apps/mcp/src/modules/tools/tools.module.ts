import { Module } from '@nestjs/common';
import { SearchToolsModule } from './search/search-tools.module';
import { EntityToolsModule } from './entity/entity-tools.module';
import { CategoryToolsModule } from './category/category-tools.module';
import { AiChatToolsModule } from './ai-chat/ai-chat-tools.module';

@Module({
  imports: [
    SearchToolsModule,
    EntityToolsModule,
    CategoryToolsModule,
    AiChatToolsModule,
  ],
})
export class ToolsModule {}
