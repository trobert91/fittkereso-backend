import { Module } from '@nestjs/common';
import { SearchModule } from '@fittkereso-backend/search';
import { DatabaseModule } from '@fittkereso-backend/database';
import { McpModule } from '@rekog/mcp-nest';
import { SearchTools } from './search.tools';

@Module({
  imports: [
    SearchModule,
    DatabaseModule,
    McpModule.forFeature([SearchTools], 'fittkereso'),
  ],
  providers: [SearchTools],
})
export class SearchToolsModule {}
