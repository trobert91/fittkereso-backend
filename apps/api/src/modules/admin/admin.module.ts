import { Module } from '@nestjs/common';
import { AdminProductController } from './controllers/admin-product.controller';
import { ProductModule } from '@fittkereso-backend/product';
import { ProductIdentityModule } from '@fittkereso-backend/product-identity';
import { AdminCategoryController } from './controllers/admin-category.controller';
import { AuthModule } from '@fittkereso-backend/auth';
import { SearchModule } from '@fittkereso-backend/search';
import { AdminBrandController } from './controllers/admin-brand.controller';
import { TaskModule } from '@fittkereso-backend/task';
import { DatabaseModule } from '@fittkereso-backend/database';
import { AdminTaskController } from './controllers/admin-task.controller';
import { AdminTestController } from './controllers/admin-test.controller';
import { AdminProductSourceController } from './controllers/admin-product-source.controller';
import { AdminProductDuplicateController } from './controllers/admin-product-duplicate.controller';
import { AdminScrapeTaskController } from './controllers/admin-scrape-task.controller';
import { AdminSellerController } from './controllers/admin-seller.controller';
import { AdminUserController } from './controllers/admin-user.controller';
import { UserModule } from '@fittkereso-backend/user';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ProductModule,
    ProductIdentityModule,
    SearchModule,
    TaskModule,
    UserModule,
  ],
  controllers: [
    AdminBrandController,
    AdminCategoryController,
    AdminProductController,
    AdminProductDuplicateController,
    AdminProductSourceController,
    AdminScrapeTaskController,
    AdminSellerController,
    AdminTaskController,
    AdminTestController,
    AdminUserController,
  ],
})
export class AdminModule {}
