import { Module, OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductModule } from '@fittkereso-backend/product';
import { ScrapeInterpreterService } from './scrape-interpreter.service';
import { ScrapeOpRegistryService } from './services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from './services/scrape-pipeline-runner.service';
import { RuntimeDataProviderService } from './services/runtime-data-provider.service';
import { ProductValueMapperService } from './services/product-value-mapper.service';
import { registerOps } from './ops/register-ops';

@Module({
  imports: [DatabaseModule, ProductModule],
  providers: [
    ScrapeInterpreterService,
    ScrapeOpRegistryService,
    ScrapePipelineRunnerService,
    RuntimeDataProviderService,
    ProductValueMapperService,
  ],
  exports: [
    ScrapeInterpreterService,
    ProductValueMapperService,
    RuntimeDataProviderService,
  ],
})
export class ScrapeInterpreterModule implements OnModuleInit {
  constructor(
    private readonly registry: ScrapeOpRegistryService,
    private readonly runner: ScrapePipelineRunnerService,
    private readonly valueMapper: ProductValueMapperService,
  ) {}

  onModuleInit(): void {
    registerOps(this.registry, this.runner, this.valueMapper);
  }
}
