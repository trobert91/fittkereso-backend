/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OpenRouterConfigService {
  constructor(private configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('openrouter.api_key')!;
  }

  get debug(): boolean {
    return this.configService.get<boolean>('openrouter.debug') ?? false;
  }
}
