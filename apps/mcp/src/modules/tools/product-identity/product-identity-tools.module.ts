import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductIdentityModule } from '@fittkereso-backend/product-identity';
import { McpModule } from '@rekog/mcp-nest';
import { NormalizedModelConsistencyTools } from './normalized-model-consistency.tools';
import { ProductIdentityTools } from './product-identity.tools';

@Module({
  imports: [
    DatabaseModule,
    ProductIdentityModule,
    McpModule.forFeature(
      [ProductIdentityTools, NormalizedModelConsistencyTools],
      'fittkereso',
    ),
  ],
  providers: [ProductIdentityTools, NormalizedModelConsistencyTools],
})
export class ProductIdentityToolsModule {}
