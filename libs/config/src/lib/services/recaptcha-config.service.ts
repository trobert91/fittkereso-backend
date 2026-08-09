/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RecaptchaConfigService {
  constructor(private configService: ConfigService) {}

  get secretKey(): string {
    return this.configService.get<string>('recaptcha.secret_key')!;
  }

  get minScore(): number {
    return this.configService.get<number>('recaptcha.min_score') ?? 0.5;
  }
}
