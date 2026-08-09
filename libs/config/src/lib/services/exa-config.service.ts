/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ExaConfigService {
  constructor(private configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('exa.api_key')!;
  }

  get apiUrl(): string {
    return (
      this.configService.get<string>('exa.api_url') ?? 'https://api.exa.ai'
    );
  }
}
