import { Module } from '@nestjs/common';
import { AdminProductController } from './controllers/admin-product.controller';
import { ProductModule } from '@fittkereso-backend/product';
import { AdminCategoryController } from './controllers/admin-category.controller';
import { AuthModule } from '@fittkereso-backend/auth';
import { SearchModule } from '@fittkereso-backend/search';
import { AdminBrandController } from './controllers/admin-brand.controller';
import { TaskModule } from '@fittkereso-backend/task';
import { DatabaseModule } from '@fittkereso-backend/database';
import { AdminTaskController } from './controllers/admin-task.controller';
import { AdminTestController } from './controllers/admin-test.controller';
import { AdminProductSourceController } from './controllers/admin-product-source.controller';
import { AdminScrapeTaskController } from './controllers/admin-scrape-task.controller';
import { AdminDuplicateController } from './controllers/admin-duplicate.controller';
import { AdminSellerController } from './controllers/admin-seller.controller';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ProductModule,
    SearchModule,
    TaskModule,
  ],
  controllers: [
    AdminBrandController,
    AdminCategoryController,
    AdminProductController,
    AdminProductSourceController,
    AdminScrapeTaskController,
    AdminSellerController,
    AdminTaskController,
    AdminTestController,
    AdminDuplicateController,
  ],
})
export class AdminModule {}
