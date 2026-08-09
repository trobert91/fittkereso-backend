/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LoggerConfigService {
  constructor(private configService: ConfigService) {}

  get appName(): string {
    return this.configService.get<string>('logging.app_name')!;
  }

  get environment(): string {
    return this.configService.get<string>('logging.environment')!;
  }

  get url(): string {
    return this.configService.get<string>('logging.url')!;
  }

  get username(): string {
    return this.configService.get<string>('logging.username')!;
  }

  get token(): string | undefined {
    return this.configService.get<string>('logging.token');
  }
}
