import { Module } from "@nestjs/common";
import { ScraperService } from "./services/scraper.service";
import { ZyteModule } from "@ebike-backend/zyte";

@Module({
  imports: [ZyteModule],
  controllers: [],
  providers: [ScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
