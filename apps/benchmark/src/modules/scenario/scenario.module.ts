import { Module } from '@nestjs/common';
import { ScenarioLoader } from './scenario-loader.service';

@Module({
  providers: [ScenarioLoader],
  exports: [ScenarioLoader],
})
export class ScenarioModule {}
