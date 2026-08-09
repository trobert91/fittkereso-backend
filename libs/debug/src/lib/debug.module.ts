import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { DatabaseModule } from "@ebike-backend/database";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { DebugTraceService } from "./services/debug-trace.service";
import { DebugTraceAssemblerService } from "./services/debug-trace-assembler.service";
import { TraceLoggerService } from "./services/trace-logger.service";
import { LokiTraceReader } from "./services/loki-trace-reader.service";

@Module({
  imports: [DatabaseModule, DynamicConfigModule, HttpModule],
  providers: [
    DebugTraceService,
    DebugTraceAssemblerService,
    TraceLoggerService,
    LokiTraceReader,
  ],
  exports: [
    DebugTraceService,
    DebugTraceAssemblerService,
    TraceLoggerService,
    LokiTraceReader,
  ],
})
export class DebugModule {}
