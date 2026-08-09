import { Module } from '@nestjs/common';
import { ReportWriterService } from './report-writer.service';

@Module({
  providers: [ReportWriterService],
  exports: [ReportWriterService],
})
export class ReportModule {}
