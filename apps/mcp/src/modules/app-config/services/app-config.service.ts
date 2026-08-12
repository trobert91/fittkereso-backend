/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PostgresConfigService,
  LoggerConfigService,
} from '@fittkereso-backend/config';

@Injectable()
export class AppConfigService {
  constructor(
    private configService: ConfigService,
    private postgresConfigService: PostgresConfigService,
    private loggerConfigService: LoggerConfigService,
  ) {}

  get environment(): string {
    return this.configService.get<string>('environment')!;
  }

  get httpPort(): number {
    return this.configService.get<number>('port') || 9232;
  }

  get postgresConfig(): PostgresConfigService {
    return this.postgresConfigService;
  }

  get loggerConfig(): LoggerConfigService {
    return this.loggerConfigService;
  }
}
