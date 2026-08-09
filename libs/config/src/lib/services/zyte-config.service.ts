/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ZyteConfigService {
  constructor(private configService: ConfigService) {}

  get apiUrl(): string {
    return this.configService.get<string>('zyte.api_url')!;
  }

  get apiKey(): string {
    return this.configService.get<string>('zyte.api_key')!;
  }
}
