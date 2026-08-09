import { Global, Module } from '@nestjs/common';
import { LoggerService } from './services/logger.service';
import { LoggerFactory } from './services/logger-factory.service';

@Global()
@Module({
  providers: [LoggerService, LoggerFactory],
  exports: [LoggerService, LoggerFactory],
})
export class LoggerModule {}
