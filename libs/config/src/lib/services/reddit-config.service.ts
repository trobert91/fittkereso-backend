/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedditConfigService {
  constructor(private configService: ConfigService) {}

  get userAgent(): string {
    return this.configService.get<string>('reddit.user_agent')!;
  }

  get clientId(): string {
    return this.configService.get<string>('reddit.client_id')!;
  }

  get clientSecret(): string {
    return this.configService.get<string>('reddit.client_secret')!;
  }

  get refreshToken(): string {
    return this.configService.get<string>('reddit.refresh_token')!;
  }
}
