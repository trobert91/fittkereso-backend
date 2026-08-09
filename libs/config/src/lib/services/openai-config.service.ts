/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OpenAiConfigService {
  constructor(private configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('openai.api_key')!;
  }

  get debug(): boolean {
    return this.configService.get<boolean>('openai.debug') ?? false;
  }
}
