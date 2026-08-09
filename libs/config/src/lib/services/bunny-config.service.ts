/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BunnyConfigService {
  constructor(private configService: ConfigService) {}

  get url(): string {
    return this.configService.get<string>('bunny.url')!;
  }

  get apiKey(): string {
    return this.configService.get<string>('bunny.api_key')!;
  }

  get cdnUrl(): string {
    return this.configService.get<string>('bunny.cdn_url')!;
  }
}
