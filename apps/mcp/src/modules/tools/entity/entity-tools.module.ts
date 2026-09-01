import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { McpModule } from '@rekog/mcp-nest';
import { EntityTools } from './entity.tools';
import { PipelineHealthTools } from './pipeline-health.tools';
import { ProductResolutionTools } from './product-resolution.tools';

@Module({
  imports: [
    DatabaseModule,
    McpModule.forFeature(
      [EntityTools, PipelineHealthTools, ProductResolutionTools],
      'fittkereso',
    ),
  ],
  providers: [EntityTools, PipelineHealthTools, ProductResolutionTools],
})
export class EntityToolsModule {}
