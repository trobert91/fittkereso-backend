/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SupabaseConfigService {
  constructor(private configService: ConfigService) {}

  get url(): string {
    return this.configService.get<string>('supabase.url')!;
  }

  get apiKey(): string {
    return this.configService.get<string>('supabase.api_key')!;
  }
}
