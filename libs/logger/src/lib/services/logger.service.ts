import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { LoggerConfigService } from '@fittkereso-backend/config';
import * as winston from 'winston';
import LokiTransport from 'winston-loki';

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: winston.Logger;

  constructor(private readonly config: LoggerConfigService) {
    this.logger = winston.createLogger({
      level: config.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
        winston.format.colorize({
          all: true,
          colors: {
            info: 'white',
            error: 'red',
            warn: 'yellow',
            debug: 'green',
            verbose: 'cyan',
          },
        }),
      ),
      defaultMeta: {
        app: config.appName,
        env: config.environment,
      },
      transports: [
        // Console
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, context }) => {
              return `[${timestamp || new Date().toISOString()}] ${context ? ' [' + context + ']' : ''} ${level}: ${message}`;
            }),
          ),
        }),

        // Loki transport
        new LokiTransport({
          format: winston.format.combine(
            winston.format.colorize({
              all: true,
              colors: {
                info: 'green',
                error: 'red',
                warn: 'yellow',
                debug: 'cyan',
                verbose: 'white',
              },
            }),
            winston.format.simple(),
          ),
          host: config.url || 'http://localhost:3100',
          labels: {
            service: config.appName,
            env: config.environment,
          },
          json: true,
          batching: true,
          interval: 5, // batch interval in seconds
          // TODO: Config for cloud
          //   basicAuth: process.env.LOKI_USER
          //     ? {
          //         username: process.env.LOKI_USER,
          //         password: process.env.LOKI_PASSWORD,
          //       }
          //     : undefined,
        }),
      ],
    });
  }

  log(message: string, context?: string, meta?: Record<string, any>) {
    this.logger.info(message, { context, ...meta });
  }

  error(message: string, meta?: Record<string, any>) {
    this.logger.error(message, meta);
  }

  warn(message: string, context?: string, meta?: Record<string, any>) {
    this.logger.warn(message, { context, ...meta });
  }

  debug(message: string, context?: string, meta?: Record<string, any>) {
    this.logger.debug(message, { context, ...meta });
  }

  verbose(message: string, context?: string, meta?: Record<string, any>) {
    this.logger.verbose(message, { context, ...meta });
  }
}
