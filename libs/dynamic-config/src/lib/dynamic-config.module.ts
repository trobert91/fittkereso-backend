import { Module } from '@nestjs/common';
import { DynamicConfigValidatorService } from './dynamic-config-validator.service';
import { DynamicConfigService } from './dynamic-config.service';
import { DynamicConfigFileLoaderService } from './dynamic-config-file-loader.service';

@Module({
  providers: [DynamicConfigValidatorService, DynamicConfigFileLoaderService, DynamicConfigService],
  exports: [DynamicConfigValidatorService, DynamicConfigService],
})
export class DynamicConfigModule {}
