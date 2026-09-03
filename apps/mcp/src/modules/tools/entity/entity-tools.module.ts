import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { McpModule } from '@rekog/mcp-nest';
import { EntityTools } from './entity.tools';
import { PipelineHealthTools } from './pipeline-health.tools';

@Module({
  imports: [
    DatabaseModule,
    McpModule.forFeature([EntityTools, PipelineHealthTools], 'fittkereso'),
  ],
  providers: [EntityTools, PipelineHealthTools],
})
export class EntityToolsModule {}
