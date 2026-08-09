/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ClaudeConfigService {
  constructor(private configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('claude.api_key')!;
  }

  get debug(): boolean {
    return this.configService.get<boolean>('claude.debug') ?? false;
  }
}
