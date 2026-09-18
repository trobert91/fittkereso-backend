import { Module } from '@nestjs/common';
import { PrometheusController } from './controllers';
import { PrometheusService } from './prometheus.service';
import {
  ProductMetricsService,
  SchedulerMetricsService,
  ScrapeTaskMetricsService,
  TaskMetricsService,
  OpenAiMetricsService,
  AiMetricsService,
  ProductSearchMetricsService,
  PublicApiMetricsService,
  ProductCollectionMetricsService,
  ZyteMetricsService,
  TranslationMetricsService,
  ProductScrapingMetricsService,
} from './services';

@Module({
  imports: [],
  controllers: [PrometheusController],
  providers: [
    PrometheusService,
    SchedulerMetricsService,
    TaskMetricsService,
    ScrapeTaskMetricsService,
    ProductMetricsService,
    AiMetricsService,
    OpenAiMetricsService,
    ProductSearchMetricsService,
    PublicApiMetricsService,
    ProductCollectionMetricsService,
    ZyteMetricsService,
    TranslationMetricsService,
    ProductScrapingMetricsService,
  ],
  exports: [
    SchedulerMetricsService,
    TaskMetricsService,
    ScrapeTaskMetricsService,
    ProductMetricsService,
    AiMetricsService,
    OpenAiMetricsService,
    ProductSearchMetricsService,
    PublicApiMetricsService,
    ProductCollectionMetricsService,
    ZyteMetricsService,
    TranslationMetricsService,
    ProductScrapingMetricsService,
  ],
})
export class MetricsModule {}
