import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { DebugTraceService } from './services/debug-trace.service';
import { TraceLoggerService } from './services/trace-logger.service';

@Module({
  imports: [DatabaseModule, DynamicConfigModule, HttpModule],
  providers: [DebugTraceService, TraceLoggerService],
  exports: [DebugTraceService, TraceLoggerService],
})
export class DebugModule {}
