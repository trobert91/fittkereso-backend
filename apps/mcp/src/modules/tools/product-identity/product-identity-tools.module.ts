import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductIdentityModule } from '@fittkereso-backend/product-identity';
import { McpModule } from '@rekog/mcp-nest';
import { ProductIdentityTools } from './product-identity.tools';

@Module({
  imports: [
    DatabaseModule,
    ProductIdentityModule,
    McpModule.forFeature([ProductIdentityTools], 'fittkereso'),
  ],
  providers: [ProductIdentityTools],
})
export class ProductIdentityToolsModule {}
