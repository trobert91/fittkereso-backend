import { Module } from '@nestjs/common';
import { ScraperService } from './services/scraper.service';
import { NativeScraperService } from './services/native-scraper.service';
import { ZyteModule } from '@fittkereso-backend/zyte';
import { HttpModule } from '@nestjs/axios';
import { MetricsModule } from '@fittkereso-backend/metrics';

@Module({
  imports: [ZyteModule, HttpModule, MetricsModule],
  controllers: [],
  providers: [ScraperService, NativeScraperService],
  exports: [ScraperService, NativeScraperService],
})
export class ScraperModule {}
