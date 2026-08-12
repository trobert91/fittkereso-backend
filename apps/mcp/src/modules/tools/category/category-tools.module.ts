import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { McpModule } from '@rekog/mcp-nest';
import { CategoryTools } from './category.tools';

@Module({
  imports: [
    DatabaseModule,
    McpModule.forFeature([CategoryTools], 'fittkereso'),
  ],
  providers: [CategoryTools],
})
export class CategoryToolsModule {}
