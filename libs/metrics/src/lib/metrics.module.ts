import { Module } from '@nestjs/common';
import { PrometheusController } from './controllers';
import { PrometheusService } from './prometheus.service';
import {
  ProductMetricsService,
  SchedulerMetricsService,
  ProductImportTaskMetricsService,
  TaskMetricsService,
  OpenAiMetricsService,
  AiMetricsService,
  ProductSearchMetricsService,
  PublicApiMetricsService,
  ProductCollectionMetricsService,
  NativeScraperMetricsService,
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
    ProductImportTaskMetricsService,
    ProductMetricsService,
    AiMetricsService,
    OpenAiMetricsService,
    ProductSearchMetricsService,
    PublicApiMetricsService,
    ProductCollectionMetricsService,
    NativeScraperMetricsService,
  ZyteMetricsService,
    TranslationMetricsService,
    ProductScrapingMetricsService,
  ],
  exports: [
    SchedulerMetricsService,
    TaskMetricsService,
    ProductImportTaskMetricsService,
    ProductMetricsService,
    AiMetricsService,
    OpenAiMetricsService,
    ProductSearchMetricsService,
    PublicApiMetricsService,
    ProductCollectionMetricsService,
    NativeScraperMetricsService,
  ZyteMetricsService,
    TranslationMetricsService,
    ProductScrapingMetricsService,
  ],
})
export class MetricsModule {}
