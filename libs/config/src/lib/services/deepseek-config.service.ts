/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DeepSeekConfigService {
  constructor(private configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('deepseek.api_key')!;
  }

  get debug(): boolean {
    return this.configService.get<boolean>('deepseek.debug') ?? false;
  }
}
