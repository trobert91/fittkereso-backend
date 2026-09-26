import { Module } from '@nestjs/common';
import { DynamicConfigValidatorService } from './dynamic-config-validator.service';
import { DynamicConfigService } from './dynamic-config.service';
import { DynamicConfigFileLoaderService } from './dynamic-config-file-loader.service';
import { OfferFreshnessService } from './offer-freshness.service';

@Module({
  providers: [
    DynamicConfigValidatorService,
    DynamicConfigFileLoaderService,
    DynamicConfigService,
    OfferFreshnessService,
  ],
  exports: [DynamicConfigValidatorService, DynamicConfigService, OfferFreshnessService],
})
export class DynamicConfigModule {}
