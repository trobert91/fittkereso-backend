import { Injectable } from '@nestjs/common';
import { CustomLogger } from '../custom-logger';

@Injectable()
export class LoggerFactory {
  createLogger(context: string): CustomLogger {
    return new CustomLogger(context);
  }
}
