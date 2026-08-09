/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailgunConfigService {
  constructor(private configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('mailgun.api_key')!;
  }

  get domain(): string {
    return this.configService.get<string>('mailgun.domain')!;
  }

  get apiUrl(): string {
    return (
      this.configService.get<string>('mailgun.api_url') ??
      'https://api.mailgun.net/v3'
    );
  }
}
