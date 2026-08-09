import { Injectable } from "@nestjs/common";
import { LoggerConfigService } from "@ebike-backend/config";
import * as winston from "winston";
import LokiTransport from "winston-loki";

/**
 * winston-loki ignores winston's `format` setting and builds the line as
 * `${info.message} ${JSON.stringify(rest)}`. When `info.message` is an
 * object, JavaScript stringifies it as `[object Object]`. We work around
 * this by JSON-encoding the payload ourselves and passing it as the
 * message string — the result is a queryable JSON line per trace in Loki.
 */
@Injectable()
export class TraceLoggerService {
  private readonly logger: winston.Logger;

  constructor(private readonly config: LoggerConfigService) {
    this.logger = winston.createLogger({
      level: "info",
      transports: [
        new LokiTransport({
          host: config.url || "http://localhost:3100",
          labels: {
            service: config.appName,
            env: config.environment,
            log_type: "processing_trace",
          },
          json: true,
          batching: true,
          interval: 3,
        }),
      ],
    });
  }

  writeTrace(data: Record<string, any>): void {
    this.emit({ ...data, traceType: "processing_trace" });
  }

  writeSystemPrompt(hash: string, content: string, step: string): void {
    this.emit({
      traceType: "system_prompt",
      hash,
      step,
      content,
    });
  }

  private emit(payload: Record<string, any>): void {
    // Single string arg → winston puts it on info.message verbatim, so
    // winston-loki writes the JSON straight to the log line.
    this.logger.info(JSON.stringify(payload));
  }
}
