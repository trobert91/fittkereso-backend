import { Module } from "@nestjs/common";
import { ScrapeTestController } from "./controllers/scrape-test.controller";
import { ScraperModule } from "@ebike-backend/scraper";
import { ProductSourceTestController } from "./controllers/product-source-test.controller";
import { TaskModule } from "@ebike-backend/task";
import { ResolutionModule } from "@ebike-backend/resolution";
import { ProductModule } from "@ebike-backend/product";
import { ProductTestController } from "./controllers/product-test.controller";
import { DatabaseModule } from "@ebike-backend/database";

@Module({
  imports: [
    DatabaseModule,
    TaskModule,
    ProductModule,
    ResolutionModule,
    ScraperModule,
  ],
  controllers: [
    ScrapeTestController,
    ProductSourceTestController,
    ProductTestController,
  ],
})
export class TestModule {}
