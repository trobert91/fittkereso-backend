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
  IncrementalSyncMetricsService,
  ProductCollectionMetricsService,
  ZyteMetricsService,
  DuplicateDetectionMetricsService,
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
    IncrementalSyncMetricsService,
    ProductCollectionMetricsService,
    ZyteMetricsService,
    DuplicateDetectionMetricsService,
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
    IncrementalSyncMetricsService,
    ProductCollectionMetricsService,
    ZyteMetricsService,
    DuplicateDetectionMetricsService,
    TranslationMetricsService,
    ProductScrapingMetricsService,
  ],
})
export class MetricsModule {}
