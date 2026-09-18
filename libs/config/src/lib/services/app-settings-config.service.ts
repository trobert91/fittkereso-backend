/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppSettingsConfigService {
  constructor(private configService: ConfigService) {}

  get appName(): string {
    return this.configService.get<string>('app_settings.app_name')!;
  }

  get appUrl(): string {
    return this.configService.get<string>('app_settings.app_url')!;
  }

  /** Origin of the admin frontend - used to build password-reset links. */
  get adminUrl(): string {
    return this.configService.get<string>('app_settings.admin_url')!;
  }
}
