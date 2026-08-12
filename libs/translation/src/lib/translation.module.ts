import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { AiModule } from '@fittkereso-backend/ai';
import { TranslationService } from './services/translation.service';

@Module({
  imports: [DatabaseModule, DynamicConfigModule, MetricsModule, AiModule],
  providers: [TranslationService],
  exports: [TranslationService],
})
export class TranslationModule {}
