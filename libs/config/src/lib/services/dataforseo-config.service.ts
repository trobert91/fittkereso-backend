/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DataForSeoConfigService {
  constructor(private configService: ConfigService) {}

  get apiUrl(): string {
    return this.configService.get<string>('dataforseo.api_url')!;
  }

  get email(): string {
    return this.configService.get<string>('dataforseo.email')!;
  }

  get password(): string {
    return this.configService.get<string>('dataforseo.password')!;
  }
}
