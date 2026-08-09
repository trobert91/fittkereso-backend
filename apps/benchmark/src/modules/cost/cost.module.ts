import { Module } from '@nestjs/common';
import { CostAnalyzerService } from './cost-analyzer.service';

@Module({
  providers: [CostAnalyzerService],
  exports: [CostAnalyzerService],
})
export class CostModule {}
