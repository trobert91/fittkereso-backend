import { Module } from '@nestjs/common';
import { ZyteScraperService } from './services/zyte-scraper.service';
import { HttpModule } from '@nestjs/axios';
import { MetricsModule } from '@fittkereso-backend/metrics';

@Module({
  imports: [HttpModule, MetricsModule],
  controllers: [],
  providers: [ZyteScraperService],
  exports: [ZyteScraperService],
})
export class ZyteModule {}
